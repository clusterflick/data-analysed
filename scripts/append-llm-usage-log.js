// Folds one transform run's LLM usage report into the month's rolling log.
//
// Usage: node scripts/append-llm-usage-log.js <report-file> <log-file>
//
// Env:
//   RUN_ID   - the data-transformed run this report came from, and the row's
//              key. Required: the report carries no identity of its own.
//   RUN_DATE - the London day that run belongs to (YYYY-MM-DD)
//   RUN_AT   - when the run started (ISO), used to order rows within a day
//
// data-transformed builds one report per transform run (scripts/llm-usage in
// the scripts repo) and uploads it as a workflow artifact, which expires after
// a fortnight and can't be compared against any other run. This turns those
// snapshots into a series: one JSONL line per run, held as a release asset on
// the month's tag, appended the way venue-health appends its hourly rows.
//
// A row per run, not per day. The transform pipeline is dispatched by each
// data-retrieved release and goes two to four times a day, so a row keyed by
// date would hold whichever run was collected last and read as though it were
// the day's total - understating spend by a factor of however many runs it
// dropped. A day's figures are the sum of its rows; nothing here pretends a
// run is a day.
//
// Keyed by run id, so re-collecting a run - a retried collection, or a
// backfill - rewrites its row rather than adding a second one.
//
// Uses only the built-in `fs` (Node 18+); no npm deps, so the workflow can run
// this without an install step.

const fs = require("fs");
const path = require("path");
const { writeBadgeFile } = require("./common/badge");

const [, , reportFile, logFile] = process.argv;

if (!reportFile || !logFile) {
  throw new Error("Usage: append-llm-usage-log.js <report-file> <log-file>");
}

// Stored at six places, not the four the report prints at: rounding each
// call-site bucket to display precision would leave them not summing to the
// run's total. Formatting is the reader's job - the badge and the log line
// below still print four.
const round = (value) => Math.round(value * 1000000) / 1000000;

const londonDate = (date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

function readReport(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`No LLM usage report at ${file}`);
  }

  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  // A report with no totals is a report this script doesn't understand, and a
  // row of zeroes would read as a quiet run rather than a broken collection.
  if (!report.totals || !report.metadata) {
    throw new Error(
      `${file} is not an LLM usage report - expected \`totals\` and \`metadata\``,
    );
  }
  return report;
}

// The per-venue breakdown is deliberately dropped: 300+ entries several times
// a day would bury the series it lives in, and the full report - venues,
// largest prompt, everything - stays in the run's artifact for its retention
// window. The log is the trend; the artifact is the detail behind any one
// point on it, for as long as it lasts.
//
// The call-site breakdown is kept, trimmed to the three figures that move:
// it's what says whether a rise came from more listings needing the LLM or
// from one stage losing its cache.
function buildRow(report, { runId, date, at }) {
  const { metadata, totals, byCallSite } = report;

  return {
    runId: Number(runId),
    date,
    ...(at && { at }),
    calls: totals.calls,
    cacheHits: totals.cacheHits,
    cacheMisses: totals.cacheMisses,
    cacheHitRate: round(totals.cacheHitRate),
    promptTokens: totals.promptTokens,
    candidatesTokens: totals.candidatesTokens,
    estimatedCostUsd: round(totals.estimatedCostUsd),
    venuesWithLlmUsage: metadata.venuesWithLlmUsage,
    venueCount: metadata.venueCount,
    // Only present when a call used a model with no listed price, in which
    // case estimatedCostUsd undercounts by whatever those calls cost - carried
    // onto the row so a dip in the series can be told apart from a pricing gap.
    ...(metadata.modelsWithoutPricing && {
      modelsWithoutPricing: metadata.modelsWithoutPricing,
    }),
    ...(metadata.largestPrompt && { largestPrompt: metadata.largestPrompt }),
    byCallSite: Object.fromEntries(
      Object.entries(byCallSite).map(([prefix, bucket]) => [
        prefix,
        {
          calls: bucket.calls,
          cacheMisses: bucket.cacheMisses,
          estimatedCostUsd: round(bucket.estimatedCostUsd),
        },
      ]),
    ),
  };
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];

  const contents = fs.readFileSync(file, "utf8").trimEnd();
  if (!contents) return [];

  return contents.split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      // Named rather than left to `JSON.parse` to report: a truncated upload
      // would otherwise surface as a bare SyntaxError with no line number, and
      // the fix depends on which line went bad.
      throw new Error(
        `${file} line ${index + 1} is not JSON (${error.message})`,
      );
    }
  });
}

function writeLog(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row)).join("\n");
  fs.writeFileSync(file, `${lines}\n`);
}

// A day is a sum over its runs, which is the whole reason rows are per-run.
function totalsForDay(rows, date) {
  const forDay = rows.filter((row) => row.date === date);
  const sum = (field) => forDay.reduce((total, row) => total + row[field], 0);
  const calls = sum("calls");

  return {
    runs: forDay.length,
    calls,
    cacheHits: sum("cacheHits"),
    cacheHitRate: calls > 0 ? sum("cacheHits") / calls : 0,
    estimatedCostUsd: sum("estimatedCostUsd"),
    unpriced: forDay.some((row) => row.modelsWithoutPricing),
  };
}

// Green only when today's figures are complete. Orange when the number on the
// badge isn't today's, or when it's an undercount because a model had no
// listed price - both are "this figure is not what it looks like", which is
// worth saying rather than colouring green and hoping someone opens the log.
//
// No spend threshold: there's no baseline to set one from yet. Once the log
// has a few weeks in it, a band around the usual daily cost belongs here.
function writeBadge(rows) {
  const today = londonDate(new Date());
  // Rows can only be missing for today on a backfill, or on the first
  // collection after a day with no successful transform run.
  const day = rows.some((row) => row.date === today)
    ? today
    : rows[rows.length - 1].date;
  const totals = totalsForDay(rows, day);
  const stale = day !== today;

  const parts = [
    `$${totals.estimatedCostUsd.toFixed(4)}`,
    `${Math.round(totals.cacheHitRate * 100)}% cached`,
    `${totals.runs} ${totals.runs === 1 ? "run" : "runs"}`,
  ];
  if (totals.unpriced) parts.push("cost incomplete");
  parts.push(stale ? `as of ${day}` : "today");

  writeBadgeFile("llm-usage.json", {
    label: "llm usage",
    message: parts.join(" · "),
    color: stale || totals.unpriced ? "orange" : "brightgreen",
  });
}

function main() {
  const runId = process.env.RUN_ID;
  const date = process.env.RUN_DATE;
  if (!runId || !date) {
    throw new Error(
      "RUN_ID and RUN_DATE must both be set - the report carries neither, so the row can't be keyed or dated without them",
    );
  }

  const report = readReport(reportFile);
  const row = buildRow(report, { runId, date, at: process.env.RUN_AT });

  const rows = readLog(logFile);
  const existing = rows.findIndex((logged) => logged.runId === row.runId);
  if (existing >= 0) {
    rows[existing] = row;
  } else {
    rows.push(row);
  }
  // Sorted rather than appended so a backfilled run sits in its place in the
  // series, and anything reading the log can trust its order. `at` is absent
  // only on a row collected without it, which sorts by date and run id.
  rows.sort(
    (a, b) =>
      (a.at ?? a.date).localeCompare(b.at ?? b.date) || a.runId - b.runId,
  );
  writeLog(logFile, rows);

  const day = totalsForDay(rows, date);
  console.log(
    `${existing >= 0 ? "Replaced" : "Added"} the row for run ${row.runId} (${rows.length} ${rows.length === 1 ? "run" : "runs"} in ${logFile})`,
  );
  console.log(
    `  this run: ${row.calls} calls, ${Math.round(row.cacheHitRate * 100)}% cached, $${row.estimatedCostUsd.toFixed(4)} across ${row.venuesWithLlmUsage}/${row.venueCount} venues`,
  );
  console.log(
    `  ${date} so far: ${day.runs} ${day.runs === 1 ? "run" : "runs"}, ${day.calls} calls, ${Math.round(day.cacheHitRate * 100)}% cached, $${day.estimatedCostUsd.toFixed(4)}`,
  );
  if (row.modelsWithoutPricing) {
    console.log(
      `  ⚠ No listed price for: ${row.modelsWithoutPricing.join(", ")} - the cost above excludes those calls`,
    );
  }

  writeBadge(rows);
}

// Same reasoning as the health log: the badge is written from the rows, so a
// collection that dies before it gets there would leave the last one up,
// reading as a healthy cycle. Say it failed, then go red.
try {
  main();
} catch (error) {
  writeBadgeFile("llm-usage.json", {
    label: "llm usage",
    message: "collection failed",
    color: "red",
  });
  throw error;
}
