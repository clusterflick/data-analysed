// Finds data-transformed runs whose LLM usage report was never folded into the
// log, so the sweep workflow can hand the oldest one to the LLM Usage Log
// workflow as a backfill.
//
// Usage: node scripts/find-uncollected-llm-usage-runs.js
//
// Env:
//   GH_TOKEN / GITHUB_TOKEN / PAT - needs `actions: read` on data-transformed
//   MAX_RUNS      - how many recent transform runs to check (default 30, about
//                   ten days - inside the report artifact's retention)
//   GRACE_MINUTES - leave runs that finished more recently than this alone
//                   (default 120)
//   LOG_REPO      - where the monthly logs are released (default
//                   $GITHUB_REPOSITORY, else clusterflick/data-analysed)
//
// Collection is normally pushed: data-transformed dispatches each run's id here
// as its report job finishes. That push can be lost - on 5 Oct a GitHub Actions
// incident left a run with a perfectly good report that never reached the log,
// and nothing noticed until the dashboard showed one run for the day. This is
// the pull that backs it up: every run that still has a usable report and has
// no row in its month's log is uncollected, whatever the reason.
//
// The grace window keeps the sweep from racing the push. A run that has just
// finished has a dispatch on its way or a collection in the queue, and the
// collection's concurrency group keeps only one pending run - a backfill
// dispatched now could cancel the very collection it duplicates.
//
// Writes run_id (the oldest uncollected run, or empty) and count to
// $GITHUB_OUTPUT (and stdout). One at a time for the same reason as the grace
// window: two dispatches queued together would cancel one another. A sweep
// every few hours clears a backlog faster than artifacts expire.
//
// Uses only the built-in fetch (Node 18+); no npm deps, same as
// find-llm-usage-run.js, whose helpers this borrows.

const {
  ARTIFACT_NAME,
  REPO,
  WORKFLOW,
  get,
  hasUsableReport,
  londonDate,
  tagFor,
  output,
} = require("./find-llm-usage-run");

const TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.PAT;
const MAX_RUNS = Number(process.env.MAX_RUNS || 30);
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 120);
const LOG_REPO =
  process.env.LOG_REPO ||
  process.env.GITHUB_REPOSITORY ||
  "clusterflick/data-analysed";
const LOG_ASSET = "llm-usage-log.jsonl";

// Completed in any conclusion, not just success: a run where a transform group
// failed still builds its report, and that spend belongs in the log too.
async function fetchRecentRuns() {
  const query = new URLSearchParams({
    per_page: String(MAX_RUNS),
    status: "completed",
    exclude_pull_requests: "true",
  });
  const body = await get(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?${query}`,
    `${REPO} ${WORKFLOW} runs`,
  );
  return body.workflow_runs || [];
}

// The run ids already in a month's log. A month with no release yet has no
// rows; anything else that stops the log being read is an error, not an empty
// log - read as empty, it would mark every run in the month uncollected.
async function collectedRunIds(tag) {
  const res = await fetch(
    `https://github.com/${LOG_REPO}/releases/download/${tag}/${LOG_ASSET}`,
    { headers: { "User-Agent": "clusterflick-data-analysed" } },
  );
  if (res.status === 404) return new Set();
  if (!res.ok) {
    throw new Error(
      `Could not read ${LOG_ASSET} on ${LOG_REPO} ${tag}: ${res.status} ${res.statusText}`,
    );
  }
  const contents = (await res.text()).trim();
  if (!contents) return new Set();
  return new Set(contents.split("\n").map((line) => JSON.parse(line).runId));
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "No token found (set GH_TOKEN, GITHUB_TOKEN or PAT) - cannot read workflow runs.",
    );
  }

  const cutoff = Date.now() - GRACE_MINUTES * 60 * 1000;
  const runs = (await fetchRecentRuns()).filter(
    (run) => new Date(run.updated_at).getTime() < cutoff,
  );

  const logs = new Map();
  const uncollected = [];
  for (const run of runs) {
    const at = run.run_started_at || run.created_at;
    const tag = tagFor(londonDate(at));
    if (!logs.has(tag)) logs.set(tag, await collectedRunIds(tag));
    if (logs.get(tag).has(run.id)) continue;
    // Asked only of runs the log is missing, which is nearly none of them -
    // this is the one API call a run costs.
    if (!(await hasUsableReport(run.id))) continue;
    uncollected.push({ run, at });
  }

  uncollected.sort((a, b) => a.at.localeCompare(b.at));
  console.log(
    `Checked ${runs.length} completed ${WORKFLOW} runs older than ${GRACE_MINUTES} minutes against ${[...logs.keys()].join(", ") || "no logs"}`,
  );
  if (!uncollected.length) {
    console.log(`Every run with a usable ${ARTIFACT_NAME} is in the log`);
  }
  for (const { run, at } of uncollected) {
    console.log(
      `Uncollected: run ${run.id} (${run.conclusion}), started ${at} - ${run.html_url}`,
    );
  }

  output({
    run_id: uncollected.length ? uncollected[0].run.id : "",
    count: uncollected.length,
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
