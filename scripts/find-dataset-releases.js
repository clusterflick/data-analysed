// Lists the releases of the two datasets clusterflick.com publishes for reuse,
// as rows for the release log, grouped by the month's log they belong in.
//
// Usage: node scripts/find-dataset-releases.js <pending-dir>
//
// Env:
//   GH_TOKEN / GITHUB_TOKEN / PAT - reads the two dataset repositories' releases
//   BACKFILL                      - "true" to list every release rather than the
//                                   most recent
//
// Writes <pending-dir>/<tag>.json - the rows for each month's log - and `tags`,
// the months touched, space separated, to $GITHUB_OUTPUT (and stdout).
//
// Each dataset dispatches the release log as it publishes, but the dispatch
// carries nothing: this lists each repository's most recent releases instead of
// taking the one that fired it. A dispatch lost to a GitHub incident, or a log
// run that failed, is then caught up by whichever release triggers it next. The
// append is keyed by repository and tag, so a release already in the log costs
// nothing.
//
// A release's month is the London month it was published in, as the LLM usage
// log's is. A run straddling midnight on the 1st touches two months' logs.
//
// Uses only the built-in fetch (Node 18+); no npm deps, so the workflow can run
// this without an install step - same as workflow-run-stats.js.

const fs = require("fs");
const path = require("path");

const TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.PAT;
const BACKFILL = process.env.BACKFILL === "true";

// The keys index.json on clusterflick.com names them by
const DATASETS = [
  { key: "data", repository: "clusterflick/data-transformed" },
  { key: "calendar", repository: "clusterflick/data-calendar" },
];

// The pipeline releases each dataset one to four times a day, so the last 30
// covers a week or more of lost dispatches.
const RECENT = 30;
const PAGE_SIZE = 100;

const [, , pendingDir] = process.argv;

async function get(url, description) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clusterflick-data-analysed",
    },
  });

  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} ${res.statusText} for ${description}`,
    );
  }

  return res.json();
}

async function listReleases(repository) {
  const perPage = BACKFILL ? PAGE_SIZE : RECENT;
  const releases = [];

  for (let page = 1; ; page += 1) {
    const batch = await get(
      `https://api.github.com/repos/${repository}/releases?per_page=${perPage}&page=${page}`,
      `${repository} releases page ${page}`,
    );
    releases.push(...batch);
    if (!BACKFILL || batch.length < perPage) break;
  }

  return releases;
}

const londonMonth = (date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}${part("month")}`;
};

function toRow(dataset, release) {
  // A release without these is not one this log can place in time, and
  // skipping it would leave a gap that reads as a missed day.
  if (!release.tag_name || !release.published_at) {
    throw new Error(
      `${dataset.repository} release ${release.id} has no tag or publish time`,
    );
  }
  return {
    dataset: dataset.key,
    repository: dataset.repository,
    tag: release.tag_name,
    publishedAt: release.published_at,
  };
}

function output(line) {
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
}

async function main() {
  if (!pendingDir) {
    throw new Error("Usage: find-dataset-releases.js <pending-dir>");
  }
  if (!TOKEN) {
    throw new Error(
      "No token found (set GH_TOKEN, GITHUB_TOKEN or PAT) - cannot read releases.",
    );
  }

  const byMonth = new Map();
  for (const dataset of DATASETS) {
    const releases = await listReleases(dataset.repository);
    // Drafts are listed to a token that can push and have no publish time;
    // they haven't been released.
    const published = releases.filter((release) => !release.draft);
    for (const release of published) {
      const row = toRow(dataset, release);
      const tag = `release-log-${londonMonth(new Date(row.publishedAt))}`;
      if (!byMonth.has(tag)) byMonth.set(tag, []);
      byMonth.get(tag).push(row);
    }
    console.error(
      `${dataset.repository}: ${published.length} release(s)${BACKFILL ? "" : ` (most recent ${RECENT})`}`,
    );
  }

  fs.mkdirSync(pendingDir, { recursive: true });
  const tags = [...byMonth.keys()].sort();
  for (const tag of tags) {
    fs.writeFileSync(
      path.join(pendingDir, `${tag}.json`),
      `${JSON.stringify(byMonth.get(tag), null, 2)}\n`,
    );
  }
  output(`tags=${tags.join(" ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
