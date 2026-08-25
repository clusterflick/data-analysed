// Folds one cycle's health rows into the day's rolling log.
//
// Usage: node scripts/append-health-log.js <health-data-dir> <log-file>
//
// Each probe writes `health-data/<group>` as a JSON array of rows. This appends
// them to a JSONL file - one row per line - because the log is only ever
// appended to and read back in order, and a line-delimited file can be extended
// without parsing what is already there. The log file is expected to already
// hold earlier cycles (the workflow downloads it from the day's release first);
// if it is absent this is the day's first cycle and it starts empty.
//
// Each row is stamped with the cycle it arrived in. The probes can't do this -
// every group starts its own observation and stamps its own `at`, so one cycle
// carries eight timestamps minutes apart - but the job folding them together
// knows they are one sample, and without that the log can't be grouped.

const fs = require("fs");
const path = require("path");
const { writeBadgeFile } = require("./common/badge");

const [, , healthDataDir, logFile] = process.argv;

if (!healthDataDir || !logFile) {
  throw new Error(
    "Usage: append-health-log.js <health-data-dir> <log-file>",
  );
}

// Only these mean something is wrong on our side. A bot challenge, or a venue
// with nothing on,
// venue is an observation about the source - see scripts/health in the scripts
// repo, which uses the same split to decide the job's exit code.
const FAILURE_KINDS = new Set(["unknown-venue-id", "probe-error"]);

function readRows(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`No health data at ${directory}`);
  }

  const rows = [];
  for (const filename of fs.readdirSync(directory).sort()) {
    const filePath = path.join(directory, filename);
    if (!fs.statSync(filePath).isFile()) continue;

    // Named rather than left to `JSON.parse` to report. A stray file here took
    // out a whole cycle once - the workflow was handing this directory the
    // browser-failure artifacts as well as the rows - and a raw SyntaxError on
    // a PNG header says nothing about which file or where it came from.
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `${filename} in ${directory} is not JSON - only probe row files belong here (${error.message})`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${filename} is not an array of rows`);
    }
    rows.push(...parsed);
  }
  return rows;
}

function main() {
  const rows = readRows(healthDataDir);
  if (rows.length === 0) {
    // A cycle that probed nothing is a broken cycle, not an empty one - every
    // probe writes a row per venue even when it was challenged or had nothing on.
    throw new Error(`No rows found in ${healthDataDir}`);
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const existing = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8")
    : "";
  const previousCycles = existing
    ? new Set(
        existing
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line).cycle),
      )
    : new Set();

  // The workflow run is the cycle. Falls back to a timestamp so a local run
  // still produces a groupable log.
  const cycle = process.env.GITHUB_RUN_ID ?? new Date().toISOString();
  const lines = rows.map((row) => JSON.stringify({ cycle, ...row })).join("\n");
  fs.writeFileSync(
    logFile,
    existing ? `${existing.trimEnd()}\n${lines}\n` : `${lines}\n`,
  );

  const byKind = {};
  for (const { reason } of rows) {
    const kind = reason?.kind ?? "ok";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const failures = Object.entries(byKind)
    .filter(([kind]) => FAILURE_KINDS.has(kind))
    .reduce((total, [, count]) => total + count, 0);
  const challenged = byKind["bot-challenge"] ?? 0;
  const noListings = byKind["no-listings-found"] ?? 0;
  const maintenance = byKind["source-maintenance"] ?? 0;
  const healthy = byKind.ok ?? 0;

  console.log(
    `Appended ${rows.length} rows as cycle ${cycle} (${previousCycles.size} earlier ${previousCycles.size === 1 ? "cycle" : "cycles"} in the log)`,
  );
  console.log(
    Object.entries(byKind)
      .sort()
      .map(([kind, count]) => `  ${kind}: ${count}`)
      .join("\n"),
  );

  // Red when a venue we track can't be observed at all; orange when the source
  // itself pushed back; green only when every venue answered.
  //
  // Challenged and empty are both amber but they are not the same thing - one is
  // the source blocking us, the other is the source telling us there is nothing
  // on - so the badge names whichever it is rather than lumping them together.
  const aside = [
    failures > 0 && `${failures} failing`,
    challenged > 0 && `${challenged} challenged`,
    maintenance > 0 && `${maintenance} in maintenance`,
    noListings > 0 && `${noListings} with no listings`,
  ].filter(Boolean);

  writeBadgeFile("venue-health.json", {
    label: "venue health",
    message:
      aside.length > 0
        ? `${healthy}/${rows.length} venues, ${aside.join(", ")}`
        : `${rows.length} venues`,
    color:
      failures > 0
        ? "red"
        : challenged + maintenance + noListings > 0
          ? "orange"
          : "brightgreen",
  });
}

// The badge is written from the rows, so a cycle that dies before it gets there
// leaves yesterday's badge up - a broken cycle reading as the last healthy one.
// Same reasoning as the probe writing its rows before it is allowed to fail: say
// what happened, then go red.
try {
  main();
} catch (error) {
  writeBadgeFile("venue-health.json", {
    label: "venue health",
    message: "cycle failed",
    color: "red",
  });
  throw error;
}
