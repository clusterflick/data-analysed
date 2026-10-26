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
// Read through the GraphQL API, which returns only the three fields a row
// needs. The REST listing returns every release with all of its assets - ~450
// a release - so a page of 100 timed out with a 504, and even a normal run's
// 30 meant downloading ~13,500 asset records to read 30 timestamps.
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
// covers a week or more of lost dispatches. A backfill pages through the rest
// at GraphQL's maximum.
const RECENT = 30;
const PAGE_SIZE = 100;
// A 5xx is GitHub failing to answer, not an answer
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

const RELEASES_QUERY = `
  query ($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      releases(
        first: $first
        after: $after
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          tagName
          publishedAt
          isDraft
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const [, , pendingDir] = process.argv;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function query(variables, description) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "clusterflick-data-analysed",
      },
      body: JSON.stringify({ query: RELEASES_QUERY, variables }),
    });

    if (res.ok) {
      const body = await res.json();
      // GraphQL reports a failed query with a 200 and an `errors` list - a
      // misnamed repository, a token without access - so a 200 alone isn't
      // an answer.
      if (body.errors?.length) {
        throw new Error(
          `GitHub GraphQL API returned errors for ${description}: ${body.errors.map((error) => error.message).join("; ")}`,
        );
      }
      return body.data;
    }

    const message = `GitHub GraphQL API returned ${res.status} ${res.statusText} for ${description}`;
    if (res.status < 500 || attempt === MAX_ATTEMPTS) throw new Error(message);
    console.error(`${message} - retrying`);
    await sleep(RETRY_DELAY_MS * attempt);
  }
}

async function listReleases(repository) {
  const [owner, name] = repository.split("/");
  const releases = [];

  for (let after = null, page = 1; ; page += 1) {
    const data = await query(
      { owner, name, first: BACKFILL ? PAGE_SIZE : RECENT, after },
      `${repository} releases page ${page}`,
    );
    const { nodes, pageInfo } = data.repository.releases;
    releases.push(...nodes);
    if (!BACKFILL || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
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
  if (!release.tagName || !release.publishedAt) {
    throw new Error(
      `${dataset.repository} release ${release.tagName ?? "(no tag)"} has no tag or publish time`,
    );
  }
  return {
    dataset: dataset.key,
    repository: dataset.repository,
    tag: release.tagName,
    publishedAt: release.publishedAt,
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
    const published = releases.filter((release) => !release.isDraft);
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
