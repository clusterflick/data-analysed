// Freshness gate for the compare workflows.
//
// The compare-* workflows gate on the freshness of the source data being
// compared — the clusterflick/data-retrieved release (set via RELEASE_REPO).
// If the latest release is older than the threshold there's nothing new to
// compare against, so we skip the (slow) download + compare rather than
// re-running against stale data.
//
// Prints a single `should_run=true|false` line to stdout (append to
// $GITHUB_OUTPUT) and all diagnostics to stderr. Never exits non-zero on a
// "stale" verdict — a skip is a normal outcome, not a failure. Exits non-zero
// only if it genuinely can't determine freshness (network/auth error), so a
// broken gate fails loudly instead of silently skipping.
//
// Uses only the built-in fetch (Node 18+); no npm deps, so it can run before
// `npm install`.

const REPO = process.env.RELEASE_REPO || "clusterflick/data-retrieved";
const MAX_AGE_MS = Number(process.env.MAX_AGE_MS || 60 * 60 * 1000); // 1 hour
const TOKEN =
  process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.PAT;

async function main() {
  if (!TOKEN) {
    throw new Error(
      "No token found (set GH_TOKEN, GITHUB_TOKEN or PAT) — cannot read releases.",
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=10`,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "clusterflick-data-analysed",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
  }

  const releases = await res.json();
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error(`No releases found for ${REPO}`);
  }

  const latest = releases
    .filter((r) => r.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];

  if (!latest) {
    throw new Error(`No published releases found for ${REPO}`);
  }

  const ageMs = Date.now() - Date.parse(latest.published_at);
  const ageMin = Math.round(ageMs / 60000);
  const fresh = ageMs <= MAX_AGE_MS;

  console.error(
    `Latest ${REPO} release: ${latest.tag_name} published ${latest.published_at} (${ageMin} min ago)`,
  );
  console.error(
    fresh
      ? `Within ${Math.round(MAX_AGE_MS / 60000)} min threshold — running comparison.`
      : `Older than ${Math.round(MAX_AGE_MS / 60000)} min threshold — skipping comparison.`,
  );

  console.log(`should_run=${fresh}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
