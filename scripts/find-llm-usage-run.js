// Finds the data-transformed run whose LLM usage report should be folded into
// the log, and hands the workflow the run id, the day it belongs to, and the
// release tag that day's row lives under.
//
// Usage: node scripts/find-llm-usage-run.js
//
// Env:
//   GH_TOKEN / GITHUB_TOKEN / PAT - needs `actions: read` on data-transformed
//   RUN_ID                        - collect this run instead of the newest
//                                   usable one (backfill)
//   MAX_RUNS                      - how far back to look (default 10)
//
// data-transformed publishes the report as a workflow artifact and nothing ever
// reads it. This is the collector's way in: resolve a run, let
// actions/download-artifact fetch the artifact from it, and let
// append-llm-usage-log.js fold it into the month's log.
//
// Writes run_id, run_date, run_at and tag to $GITHUB_OUTPUT (and stdout).
// Normally the run id arrives with the dispatch that data-transformed sends as
// its report job finishes, and this resolves it to the date, timestamp and
// release tag the row needs. Resolving the newest usable run instead is the
// manual path, for a collection that was missed.
//
// The newest run is not always the usable one. create_llm_usage_report `needs:`
// every transform job, so on a run where any of them failed the report job is
// skipped rather than failed, and that run has no artifact at all. Walking back
// past those is what finds the last run that can actually be collected - the
// append is keyed by run id, so re-collecting one already in the log rewrites
// that row rather than duplicating it.
//
// Uses only the built-in fetch (Node 18+); no npm deps, so the workflow can run
// this without an install step - same as workflow-run-stats.js.

const fs = require("fs");

const TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.PAT;
const MAX_RUNS = Number(process.env.MAX_RUNS || 10);

const REPO = "clusterflick/data-transformed";
const WORKFLOW = "transform.yml";
const ARTIFACT_NAME = "llm-usage-report";

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

async function fetchRun(runId) {
  return get(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}`,
    `${REPO} run ${runId}`,
  );
}

// Expired artifacts are still listed, with `expired: true` and a download that
// 410s - so presence in the list is not enough to know the report can still be
// had. This is the window the whole collector exists to outlive.
async function hasUsableReport(runId) {
  const body = await get(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
    `${REPO} run ${runId} artifacts`,
  );
  return (body.artifacts || []).some(
    (artifact) => artifact.name === ARTIFACT_NAME && !artifact.expired,
  );
}

// The pipeline runs on Europe/London, so a run that started at 00:30 BST
// belongs to that London day rather than to the UTC day its timestamp names.
function londonDate(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

// Derived from the run's own date, not today's, so a backfill lands in the
// month it belongs to rather than the month it was collected in. Prefixed
// because venue-health already holds the bare YYYYMMDD tags in this repo.
function tagFor(date) {
  return `llm-usage-${date.slice(0, 4)}${date.slice(5, 7)}`;
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  console.log(lines.join("\n"));
}

async function findRun() {
  // An explicit backfill that names a run with no report is a mistake worth
  // reporting, not a reason to quietly collect a different day.
  if (process.env.RUN_ID) {
    const run = await fetchRun(process.env.RUN_ID);
    if (!(await hasUsableReport(run.id))) {
      throw new Error(
        `Run ${run.id} has no usable ${ARTIFACT_NAME} artifact - it either never produced one (a transform job failed, so create_llm_usage_report was skipped) or the artifact has expired`,
      );
    }
    return run;
  }

  const runs = await fetchRecentRuns();
  for (const run of runs) {
    if (await hasUsableReport(run.id)) return run;
  }

  throw new Error(
    `No ${ARTIFACT_NAME} artifact on any of the last ${runs.length} completed ${WORKFLOW} runs in ${REPO}`,
  );
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "No token found (set GH_TOKEN, GITHUB_TOKEN or PAT) - cannot read workflow runs.",
    );
  }

  const run = await findRun();
  const at = run.run_started_at || run.created_at;
  const date = londonDate(at);

  console.log(
    `Collecting ${WORKFLOW} run ${run.id} (${run.html_url}), started ${at}`,
  );
  output({ run_id: run.id, run_date: date, run_at: at, tag: tagFor(date) });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
