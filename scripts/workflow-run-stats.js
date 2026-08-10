// Measures how stable the retrieve and transform pipelines are, as badges.
//
// Two figures per workflow, over a rolling window of completed runs:
//   unassisted — how often the run finished first time with nobody stepping in
//   duration   — how long those clean runs took, wall-clock
//
// A run counts as unassisted when `run_attempt` is 1 and it succeeded. Nothing
// in these repos re-runs itself, and the `nick-fields/retry` wrappers inside
// the retrieve jobs retry *within* a step, so `run_attempt` only ever goes past
// 1 because a human clicked "re-run". Anything else that completed — failed,
// cancelled, or eventually succeeded on a later attempt — counts against the
// percentage. Runs still in progress are ignored entirely.
//
// Duration deliberately only averages the unassisted runs. GitHub rewrites
// `run_started_at` to the *latest* attempt when a run is re-run, so a retried
// run's elapsed time doesn't describe anything real — and the gap between
// attempts is mostly time spent waiting for someone to notice, which says
// nothing about the pipeline.
//
// Usage: node scripts/workflow-run-stats.js
//
// Env:
//   GH_TOKEN / GITHUB_TOKEN / PAT — needs `actions: read` on both pipeline repos
//   WINDOW_DAYS                   — size of the window (default 30)
//
// Uses only the built-in fetch (Node 18+); no npm deps, so the workflow can run
// this without an `npm install` step.

const { writeBadgeFile } = require("./common/badge");

const TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.PAT;
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);

// Colour bands for the unassisted percentage. Chosen so that "needs a hand
// more than once a week" stops being green.
const GOOD_PERCENT = 90;
const OK_PERCENT = 75;

const TARGETS = [
  {
    repo: "clusterflick/data-retrieved",
    workflow: "retrieve.yml",
    unassistedFile: "retrieve-unassisted.json",
    durationFile: "retrieve-duration.json",
  },
  {
    repo: "clusterflick/data-transformed",
    workflow: "transform.yml",
    unassistedFile: "transform-unassisted.json",
    durationFile: "transform-duration.json",
  },
];

async function fetchRuns(repo, workflow, since) {
  const runs = [];
  const perPage = 100;

  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      created: `>=${since}`,
      exclude_pull_requests: "true",
    });
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?${query}`;

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
        `GitHub API returned ${res.status} ${res.statusText} for ${repo} ${workflow}`,
      );
    }

    const body = await res.json();
    const batch = body.workflow_runs || [];
    runs.push(...batch);

    if (batch.length < perPage) break;
  }

  // The `created` filter is applied server-side, but re-check locally so a
  // silently-ignored filter can't quietly widen the window.
  const cutoff = Date.parse(since);
  return runs.filter((run) => Date.parse(run.created_at) >= cutoff);
}

function summarise(runs) {
  const completed = runs.filter((run) => run.status === "completed");
  const unassisted = completed.filter(
    (run) => run.run_attempt === 1 && run.conclusion === "success",
  );

  const durationsMs = unassisted.map(
    (run) => Date.parse(run.updated_at) - Date.parse(run.run_started_at),
  );
  const averageMs =
    durationsMs.length > 0
      ? durationsMs.reduce((total, ms) => total + ms, 0) / durationsMs.length
      : null;

  return {
    total: completed.length,
    unassisted: unassisted.length,
    averageMs,
  };
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function percentColour(percent) {
  if (percent >= GOOD_PERCENT) return "brightgreen";
  if (percent >= OK_PERCENT) return "orange";
  return "red";
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      "No token found (set GH_TOKEN, GITHUB_TOKEN or PAT) — cannot read workflow runs.",
    );
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  const label = `${WINDOW_DAYS} days`;

  for (const target of TARGETS) {
    const runs = await fetchRuns(target.repo, target.workflow, since);
    const { total, unassisted, averageMs } = summarise(runs);

    console.log(`\n${target.repo} (${target.workflow}) since ${since}`);

    if (total === 0) {
      console.log("  No completed runs in the window.");
      writeBadgeFile(target.unassistedFile, {
        label,
        message: "no runs",
        color: "lightgrey",
      });
      writeBadgeFile(target.durationFile, {
        label,
        message: "no runs",
        color: "lightgrey",
      });
      continue;
    }

    const percent = Math.round((unassisted / total) * 100);
    console.log(`  ${unassisted} of ${total} completed first time (${percent}%)`);

    writeBadgeFile(target.unassistedFile, {
      label,
      message: `${percent}% - ${unassisted} of ${total} first time`,
      color: percentColour(percent),
    });

    writeBadgeFile(target.durationFile, {
      label,
      message:
        averageMs === null
          ? "no clean runs"
          : `${formatDuration(averageMs)} average time`,
      color: averageMs === null ? "lightgrey" : "blue",
    });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
