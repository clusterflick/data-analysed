// Measures how the pipeline is doing, as badges, over a rolling window of
// completed runs.
//
// Every workflow below gets a duration badge — how long a clean run takes,
// wall-clock. Three of them (retrieve, transform, match) also get an
// unassisted badge: how often the run finished first time with nobody
// stepping in.
//
// A run counts as unassisted when `run_attempt` is 1 and it succeeded. Those
// three repos have no auto-rerun workflow, and the `nick-fields/retry`
// wrappers inside their jobs retry *within* a step, so `run_attempt` only ever
// goes past 1 because a human clicked "re-run". Anything else that completed —
// failed, cancelled, or eventually succeeded on a later attempt — counts
// against the percentage. Runs still in progress are ignored entirely.
//
// The rest are duration-only, because that percentage would mean something
// different for each of them. diff, combine and calendar each carry a
// `rerun-on-failure.yml` that re-runs them automatically, so a later attempt
// says nothing about whether a person was involved; and both site builds set
// `cancel-in-progress`, so a superseding release routinely cancels a run that
// was never in trouble. Neither distorts duration, which only ever averages
// first-attempt successes — retried and cancelled runs are already out of it.
//
// data-cached is deliberately absent. It opens with the same "already released
// today?" guard as data-matched, but its `trigger_downstream` job runs even on
// a guarded skip, so `didNothing` below cannot recognise those runs — and a
// 30-second no-op would then be averaged in as though it were a real build.
//
// data-matched is dispatched by every data-combined release but only builds one
// release a day: its first job looks for today's release and, when there is
// one, every other job is skipped. Those runs finish in seconds having done
// nothing, so they're dropped from the window entirely rather than counted as
// successes — see `didNothing` below.
//
// Duration deliberately only averages first-attempt successes. GitHub rewrites
// `run_started_at` to the *latest* attempt when a run is re-run, so a retried
// run's elapsed time doesn't describe anything real — and the gap between
// attempts is mostly time spent waiting for someone to notice, which says
// nothing about the pipeline.
//
// Usage: node scripts/workflow-run-stats.js
//
// Env:
//   GH_TOKEN / GITHUB_TOKEN / PAT — needs `actions: read` on every repo in TARGETS
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

// In pipeline order. `durationFile` is required; `unassistedFile` is only set
// on the three workflows where the percentage is meaningful — see above.
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
  {
    repo: "clusterflick/data-diffed",
    workflow: "diff.yml",
    durationFile: "diff-duration.json",
  },
  {
    repo: "clusterflick/data-combined",
    workflow: "combine.yml",
    durationFile: "combine-duration.json",
  },
  {
    repo: "clusterflick/data-matched",
    workflow: "match.yml",
    unassistedFile: "match-unassisted.json",
    durationFile: "match-duration.json",
    // Set on workflows that open with a "have we already done this today?"
    // job; runs where that guard skipped everything else are discarded.
    guardJob: "Check if release already created today",
  },
  {
    repo: "clusterflick/data-calendar",
    workflow: "generate_calendar.yml",
    durationFile: "calendar-duration.json",
  },
  {
    repo: "clusterflick/clusterflick.com",
    workflow: "generate_site.yml",
    durationFile: "website-duration.json",
  },
  {
    repo: "clusterflick/analysis.clusterflick.com",
    workflow: "generate_site.yml",
    durationFile: "analysis-site-duration.json",
  },
];

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
    const body = await get(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?${query}`,
      `${repo} ${workflow}`,
    );
    const batch = body.workflow_runs || [];
    runs.push(...batch);

    if (batch.length < perPage) break;
  }

  // The `created` filter is applied server-side, but re-check locally so a
  // silently-ignored filter can't quietly widen the window.
  const cutoff = Date.parse(since);
  return runs.filter((run) => Date.parse(run.created_at) >= cutoff);
}

// True when the run's guard job was the only thing that did anything — every
// other job in it was skipped. Only asked of runs that succeeded, because a run
// that failed or was cancelled always leaves a job concluded that way, so this
// can never quietly discard one.
async function didNothing(repo, runId, guardJob) {
  const body = await get(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    `${repo} run ${runId} jobs`,
  );
  const all = body.jobs || [];
  // Guarded workflows are small, so one page holds them all. If one ever
  // outgrows that, keep the run rather than judging it on a partial list.
  if (all.length < (body.total_count || 0)) return false;

  const jobs = all.filter((job) => job.name !== guardJob);
  return jobs.length > 0 && jobs.every((job) => job.conclusion === "skipped");
}

async function dropNoOpRuns(repo, runs, guardJob) {
  const kept = [];
  for (const run of runs) {
    if (
      run.conclusion === "success" &&
      (await didNothing(repo, run.id, guardJob))
    ) {
      continue;
    }
    kept.push(run);
  }
  return kept;
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
    const allRuns = await fetchRuns(target.repo, target.workflow, since);
    const runs = target.guardJob
      ? await dropNoOpRuns(target.repo, allRuns, target.guardJob)
      : allRuns;
    const { total, unassisted, averageMs } = summarise(runs);

    console.log(`\n${target.repo} (${target.workflow}) since ${since}`);

    const noOps = allRuns.length - runs.length;
    if (noOps > 0) {
      console.log(`  ${noOps} runs skipped everything and were discarded`);
    }

    if (total === 0) {
      console.log("  No completed runs in the window.");
      if (target.unassistedFile) {
        writeBadgeFile(target.unassistedFile, {
          label,
          message: "no runs",
          color: "lightgrey",
        });
      }
      writeBadgeFile(target.durationFile, {
        label,
        message: "no runs",
        color: "lightgrey",
      });
      continue;
    }

    // Logged for every target, badged only for the three that publish it — the
    // figure is still worth having in the run log for the rest.
    const percent = Math.round((unassisted / total) * 100);
    console.log(
      `  ${unassisted} of ${total} completed first time (${percent}%)`,
    );

    if (target.unassistedFile) {
      writeBadgeFile(target.unassistedFile, {
        label,
        message: `${percent}% - ${unassisted} of ${total} first time`,
        color: percentColour(percent),
      });
    }

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
