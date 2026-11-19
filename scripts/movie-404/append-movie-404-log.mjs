// Logs the film URLs a deploy of clusterflick.com left behind, and what the
// movie-redirects Worker now does with each.
//
// Usage: node scripts/movie-404/append-movie-404-log.mjs \
//          <current-map> <previous-map> <log-file>
//
// `<previous-map>` may not exist: the first run has nothing to compare with,
// keeps the map it was given for the next run, and logs nothing.
//
// Each deploy publishes /movie-urls.json: every film page it built, and what
// the Worker needs to send a dead film URL somewhere. Two consecutive maps
// say exactly which URLs stopped being pages, and running each one through
// the Worker's own rules (`findLostUrls` in @clusterflick/catalogue, the
// module the Worker runs) says whether it's now a redirect or a 404 - on the
// day the deploy made it, rather than weeks later when a crawler follows it.
//
// One JSONL row per deploy, keyed by the map's `generatedAt`, so a re-run
// against the same deploy rewrites its row rather than adding a second.
//
// Writes `changed=true|false` to GITHUB_OUTPUT: false when the map is the
// one compared last time (a second dispatch for one deploy), which publishes
// nothing.

import fs from "node:fs";
import path from "node:path";
import {
  findLostUrls,
  MOVIE_URL_MAP_VERSION,
} from "@clusterflick/catalogue/utils/movie-url-map";

const [, , currentFile, previousFile, logFile] = process.argv;
if (!currentFile || !previousFile || !logFile) {
  throw new Error(
    "Usage: append-movie-404-log.mjs <current-map> <previous-map> <log-file>",
  );
}

function readMap(file) {
  const map = JSON.parse(fs.readFileSync(file, "utf8"));
  // A map this version of the catalogue doesn't read would be compared
  // wrongly rather than not at all: fail, and keep the last good baseline.
  if (map?.version !== MOVIE_URL_MAP_VERSION) {
    throw new Error(
      `${file} is version ${map?.version}; @clusterflick/catalogue reads ${MOVIE_URL_MAP_VERSION}`,
    );
  }
  if (typeof map.generatedAt !== "string" || typeof map.slugs !== "object") {
    throw new Error(`${file} has no generatedAt or slugs`);
  }
  return map;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

/**
 * Whether a lost URL is worth a person's look. A redirect by id or by a
 * matched listing's hash is exact, and a finished listing or a pruned
 * departed page with nowhere to go is the expected end of one; neither is.
 * What's left is what the fuzzy thresholds and the pipeline can get wrong.
 */
function reviewReason({ kind, decision }) {
  if (kind === "lost") return "showing film left with no departed page";
  if (kind === "unknown") return null;
  if (decision.outcome === "redirect") {
    return decision.status === 302 ? "redirected by title: check the film" : null;
  }
  if (decision.reason === "ambiguous") return "several showing films match";
  if (decision.reason === "canonical") return "its own page is a 404";
  if (kind === "retitled") return "retitled, yet not redirected";
  return null;
}

const outcomeOf = ({ decision }) =>
  decision.outcome === "redirect"
    ? `${decision.status} ${decision.rule}`
    : `404 ${decision.reason}`;

const count = (items, keyOf) => {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
};

const current = readMap(currentFile);

if (!fs.existsSync(previousFile)) {
  console.log(
    `No previous map: ${current.generatedAt} is the baseline for the next deploy`,
  );
  setOutput("changed", "false");
  process.exit(0);
}

const previous = readMap(previousFile);
if (previous.generatedAt === current.generatedAt) {
  console.log(`${current.generatedAt} was compared already; nothing to add`);
  setOutput("changed", "false");
  process.exit(0);
}
// A deploy older than the baseline is a re-run of an old workflow, or two
// deploys finishing out of order. Comparing backwards would log pages that
// came back as pages that went.
if (current.generatedAt < previous.generatedAt) {
  throw new Error(
    `The live map (${current.generatedAt}) is older than the last one compared (${previous.generatedAt})`,
  );
}

const lost = findLostUrls(previous, current);
const urls = lost.map((url) => {
  const review = reviewReason(url);
  return {
    path: url.path,
    kind: url.kind,
    ...url.decision,
    ...(review && { review }),
  };
});

const row = {
  deployedAt: current.generatedAt,
  previousDeployedAt: previous.generatedAt,
  pages: {
    previous: Object.keys(previous.slugs).length,
    current: Object.keys(current.slugs).length,
  },
  lost: lost.length,
  redirected: lost.filter(({ decision }) => decision.outcome === "redirect")
    .length,
  review: urls.filter((url) => url.review).length,
  byKind: count(lost, ({ kind }) => kind),
  byOutcome: count(lost, outcomeOf),
  urls,
};

const rows = fs.existsSync(logFile)
  ? fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const kept = rows.filter((existing) => existing.deployedAt !== row.deployedAt);
kept.push(row);
kept.sort((a, b) => a.deployedAt.localeCompare(b.deployedAt));
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
setOutput("changed", "true");

console.log(
  `${previous.generatedAt} -> ${current.generatedAt}: ${lost.length} film URLs stopped being pages, ${row.redirected} now redirect, ${row.review} to review`,
);
for (const [outcome, n] of Object.entries(row.byOutcome)) {
  console.log(`  ${outcome}: ${n}`);
}

// The step summary is where a person reading the run looks first.
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `### Film URLs this deploy left behind`,
    ``,
    `${previous.generatedAt} → ${current.generatedAt}: **${lost.length}** stopped being pages, **${row.redirected}** now redirect, **${row.review}** to review.`,
    ``,
    `| Outcome | URLs |`,
    `| --- | --- |`,
    ...Object.entries(row.byOutcome).map(([o, n]) => `| ${o} | ${n} |`),
  ];
  const toReview = urls.filter((url) => url.review);
  if (toReview.length > 0) {
    lines.push(``, `| To review | Why | Now |`, `| --- | --- | --- |`);
    for (const url of toReview) {
      const now =
        url.outcome === "redirect" ? `${url.status} → ${url.location}` : "404";
      lines.push(`| \`${url.path}\` | ${url.review} | ${now} |`);
    }
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
