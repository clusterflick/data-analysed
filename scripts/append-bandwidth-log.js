// Appends one router reading to the month's bandwidth log.
//
// Usage: ROW='<json>' node scripts/append-bandwidth-log.js <log-file>
//
// ROW is the reading read-router-usage.js produced on the self-hosted runner.
// It comes across a job boundary as a string, so it is checked here before it
// joins the log rather than trusted: this job is the one with write access.
//
// One JSONL line per reading, in the order they were taken. A reading is the
// router's running total for its month at that instant - see
// read-router-usage.js for why the log holds totals rather than usage.
//
// Keyed by `at`, so appending the same reading twice (a re-run of the collect
// job alone) leaves one row.
//
// Uses only the built-in `fs` (Node 18+); no npm deps, so the workflow can run
// this without an install step.

const fs = require("fs");
const path = require("path");

const [, , logFile] = process.argv;

if (!logFile) {
  throw new Error("Usage: append-bandwidth-log.js <log-file>");
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function parseRow(text) {
  if (!text) throw new Error("ROW must be set");
  const row = JSON.parse(text);
  if (
    typeof row.at !== "string" ||
    Number.isNaN(Date.parse(row.at)) ||
    !isCount(row.rx) ||
    !isCount(row.tx) ||
    !isCount(row.connectedSeconds)
  ) {
    throw new Error(`Not a router reading: ${text}`);
  }
  return {
    at: row.at,
    rx: row.rx,
    tx: row.tx,
    connectedSeconds: row.connectedSeconds,
    ...(isCount(row.resetDay) && { resetDay: row.resetDay }),
    ...(typeof row.autoReset === "boolean" && { autoReset: row.autoReset }),
  };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;

const row = parseRow(process.env.ROW);
const rows = readLog(logFile).filter((existing) => existing.at !== row.at);
rows.push(row);
rows.sort((a, b) => a.at.localeCompare(b.at));

fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log(
  `Logged ${row.at}: ${gigabytes(row.rx)} down, ${gigabytes(row.tx)} up this router month (${rows.length} readings in the log)`,
);
