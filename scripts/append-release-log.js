// Folds dataset releases into a month's release log.
//
// Usage: node scripts/append-release-log.js <rows-file> <log-file>
//
// The rows come from find-dataset-releases.js: one per release of the two
// datasets clusterflick.com publishes for reuse, `{ dataset, repository, tag,
// publishedAt }`. The log is `release-log.jsonl` on this repository's
// `release-log-YYYYMM` release, one JSON line per release, sorted by publish
// time. clusterflick.com reads every month's log at build time for its data
// status page: how long the datasets have been released, how often, and at
// what time of day.
//
// The GitHub releases are the source, and this is their record: it outlives a
// release being deleted, and gives the site one file a month to read rather
// than paging through two repositories' release lists on every build.
//
// Keyed by repository and tag, so a release already in the log is left as it
// is - every run lists the most recent releases, most of which are logged.
//
// Writes `changed=true|false` to $GITHUB_OUTPUT (and stdout), so a run that
// added nothing doesn't republish the month's log.
//
// Uses only the built-in `fs`; no npm deps, so the workflow can run this
// without an install step.

const fs = require("fs");
const path = require("path");

const [, , rowsFile, logFile] = process.argv;

const key = (row) => `${row.repository}@${row.tag}`;

function readLog(file) {
  if (!fs.existsSync(file)) return [];

  const contents = fs.readFileSync(file, "utf8").trimEnd();
  if (!contents) return [];

  return contents.split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      // Named rather than left to `JSON.parse` to report: a truncated upload
      // would otherwise surface as a bare SyntaxError with no line number.
      throw new Error(
        `${file} line ${index + 1} is not JSON (${error.message})`,
      );
    }
  });
}

function output(line) {
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
}

function main() {
  if (!rowsFile || !logFile) {
    throw new Error("Usage: append-release-log.js <rows-file> <log-file>");
  }

  const incoming = JSON.parse(fs.readFileSync(rowsFile, "utf8"));
  const rows = readLog(logFile);
  const logged = new Map(rows.map((row) => [key(row), row]));

  const added = [];
  for (const row of incoming) {
    const existing = logged.get(key(row));
    if (!existing) {
      logged.set(key(row), row);
      rows.push(row);
      added.push(row);
    } else if (existing.publishedAt !== row.publishedAt) {
      // A publish time is fixed once a release is out. One that moved means
      // the release was deleted and recreated under the same tag, which is
      // worth a person's look rather than a silent rewrite of the record.
      throw new Error(
        `${key(row)} is logged as published at ${existing.publishedAt} but GitHub now says ${row.publishedAt}`,
      );
    }
  }

  if (added.length === 0) {
    console.log(`Nothing new for ${logFile} (${rows.length} release(s))`);
    output("changed=false");
    return;
  }

  // Sorted rather than appended so a backfilled release sits in its place, and
  // anything reading the log can trust its order.
  rows.sort(
    (a, b) =>
      a.publishedAt.localeCompare(b.publishedAt) ||
      a.repository.localeCompare(b.repository),
  );
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(
    logFile,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  for (const row of added) {
    console.log(`Added ${row.repository} ${row.tag} (${row.publishedAt})`);
  }
  console.log(`${rows.length} release(s) in ${logFile}`);
  output("changed=true");
}

main();
