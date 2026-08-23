const fs = require("fs");
const path = require("path");
const { writeBadgeFile } = require("./common/badge");

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadCinemourData(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadTransformedData(dir) {
  const venues = {};
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    try {
      venues[file] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // skip non-JSON
    }
  }
  return venues;
}

// ---------------------------------------------------------------------------
// Target films — Cinemour films it currently considers "in cinemas"
//
// Cinemour's `/api/in-cinemas` groups films into `openingThisWeek`,
// `nowShowing`, `comingSoon` and `laterThisYear`. Only the first two are
// meant to be bookable right now; `comingSoon`/`laterThisYear` are future
// releases we wouldn't expect to have screenings for yet, so they're excluded.
// A film can appear in both `openingThisWeek` and `nowShowing` categories.
// ---------------------------------------------------------------------------

function buildTargetFilms(cinemourData) {
  const opening = cinemourData.data.openingThisWeek || [];
  const nowShowing = cinemourData.data.nowShowing || [];
  const byId = new Map();

  for (const film of opening) {
    byId.set(film.id, { ...film, lists: new Set(["openingThisWeek"]) });
  }
  for (const film of nowShowing) {
    if (byId.has(film.id)) {
      byId.get(film.id).lists.add("nowShowing");
    } else {
      byId.set(film.id, { ...film, lists: new Set(["nowShowing"]) });
    }
  }

  return byId;
}

// ---------------------------------------------------------------------------
// Our TMDB index — TMDB id -> venues with a future performance for it
//
// A showing carries a single match (`themoviedb`) or, for double
// bills/seasons, multiple matches (`themoviedbs`). Only showings with at
// least one future performance count, mirroring what "in cinemas now" means.
// ---------------------------------------------------------------------------

function buildOurTmdbIndex(transformedVenues, nowMs) {
  const index = new Map();

  for (const [venueId, showings] of Object.entries(transformedVenues)) {
    if (!Array.isArray(showings)) continue;

    for (const showing of showings) {
      const futurePerformances = (showing.performances || []).filter(
        (p) => p.time >= nowMs,
      ).length;
      if (futurePerformances === 0) continue;

      const tmdbMatches = [
        ...(showing.themoviedb ? [showing.themoviedb] : []),
        ...(showing.themoviedbs || []),
      ];

      for (const match of tmdbMatches) {
        if (!match || typeof match.id !== "number") continue;
        if (!index.has(match.id)) {
          index.set(match.id, {
            title: match.title,
            venues: new Map(), // venueId -> future performance count
          });
        }
        const entry = index.get(match.id);
        entry.venues.set(
          venueId,
          (entry.venues.get(venueId) || 0) + futurePerformances,
        );
      }
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareFilms(targetFilms, ourIndex) {
  const matched = [];
  const missing = [];

  for (const film of targetFilms.values()) {
    const ours = ourIndex.get(film.id);
    if (ours) {
      matched.push({ film, ours });
    } else {
      missing.push(film);
    }
  }

  return { matched, missing };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatFilmLine(film) {
  const lists = [...film.lists].join(", ");
  const tmdbUrl = `https://www.themoviedb.org/movie/${film.id}`;
  const reRelease = film.isReRelease ? ` ${c.dim}[re-release]${c.reset}` : "";
  return [
    `  ${film.title} ${c.dim}(${film.release_date}, TMDB #${film.id}, ${lists})${c.reset}${reRelease}`,
    `    ${c.dim}${tmdbUrl}${c.reset}`,
  ];
}

function formatReport(targetFilms, matched, missing, cinemourData) {
  const lines = [];

  lines.push(`${c.bold}${c.cyan}Cinemour Screenings Comparison${c.reset}`);
  lines.push(`  Cinemour data fetched: ${cinemourData.metadata.fetchedAt}`);
  lines.push("");

  const openingMissing = missing.filter((f) => f.lists.has("openingThisWeek"));
  const nowShowingOnlyMissing = missing.filter(
    (f) => !f.lists.has("openingThisWeek"),
  );

  lines.push(`${c.bold}Summary${c.reset}`);
  lines.push(`  Cinemour films (opening + now showing): ${targetFilms.size}`);
  lines.push(`  Matched (found in our data):            ${c.green}${matched.length}${c.reset}`);
  lines.push(
    `  Missing — opening this week:            ${openingMissing.length > 0 ? c.red : ""}${openingMissing.length}${c.reset}`,
  );
  lines.push(
    `  Missing — now showing only:             ${nowShowingOnlyMissing.length > 0 ? c.yellow : ""}${nowShowingOnlyMissing.length}${c.reset}`,
  );
  lines.push("");

  if (openingMissing.length > 0) {
    lines.push(
      `${c.bold}${c.red}Missing — opening this week (${openingMissing.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}New releases Cinemour lists as opening this week that we have no future screening for anywhere.${c.reset}`,
    );
    lines.push("");
    for (const film of openingMissing.sort((a, b) =>
      a.title.localeCompare(b.title),
    )) {
      lines.push(...formatFilmLine(film));
    }
    lines.push("");
  }

  if (nowShowingOnlyMissing.length > 0) {
    lines.push(
      `${c.bold}${c.yellow}Missing — now showing only (${nowShowingOnlyMissing.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}Films Cinemour lists as currently showing (many are rep/repertory re-releases) that we have no future screening for anywhere. Higher noise than "opening this week" — expect some genuine coverage gaps here (venues/formats Cinemour tracks that we don't).${c.reset}`,
    );
    lines.push("");
    for (const film of nowShowingOnlyMissing.sort((a, b) =>
      a.title.localeCompare(b.title),
    )) {
      lines.push(...formatFilmLine(film));
    }
    lines.push("");
  }

  if (missing.length === 0) {
    lines.push(
      `${c.green}All Cinemour "in cinemas" films matched to a future screening in our data.${c.reset}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Badge
//
// This check is film-level, not venue-level, so the shared venue-scoped
// writeBadge() helper doesn't fit (it phrases counts as "across N venues").
// A missing "opening this week" film is a much stronger signal than a missing
// "now showing" one (which includes a lot of rep/repertory noise — see the
// report), so only the former forces red.
// ---------------------------------------------------------------------------

function pluralise(word, n) {
  return n === 1 ? word : `${word}s`;
}

function writeCinemourBadge({ openingMissing, nowShowingOnlyMissing }) {
  const total = openingMissing + nowShowingOnlyMissing;

  let color = "brightgreen";
  if (openingMissing > 0) color = "red";
  else if (total > 0) color = "orange";

  const parts = [];
  if (openingMissing > 0) {
    parts.push(
      `${openingMissing} missing ${pluralise("new release", openingMissing)}`,
    );
  }
  if (nowShowingOnlyMissing > 0) {
    parts.push(
      `${nowShowingOnlyMissing} missing now-showing ${pluralise("film", nowShowingOnlyMissing)}`,
    );
  }
  const message = parts.length > 0 ? parts.join(", ") : "all matching";

  return writeBadgeFile("compare-cinemour-screenings.json", {
    label: "Compare Cinemour Screenings",
    message,
    color,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [cinemourDataPath, transformedDir] = process.argv.slice(2);

  if (!cinemourDataPath || !transformedDir) {
    console.error(
      "Usage: compare-cinemour-screenings.js <cinemour-data-path> <transformed-data-dir>",
    );
    process.exit(1);
  }

  console.log(`Loading Cinemour data from ${cinemourDataPath}...`);
  const cinemourData = loadCinemourData(cinemourDataPath);
  const targetFilms = buildTargetFilms(cinemourData);
  console.log(`  ${targetFilms.size} films opening this week / now showing`);

  console.log(`Loading transformed data from ${transformedDir}...`);
  const transformedVenues = loadTransformedData(transformedDir);
  console.log(`  ${Object.keys(transformedVenues).length} venue files`);

  const now = new Date();
  console.log(`\nIndexing our screenings (from ${now.toISOString()})...`);
  const ourIndex = buildOurTmdbIndex(transformedVenues, now.getTime());
  console.log(`  ${ourIndex.size} distinct TMDB films with a future screening`);

  const { matched, missing } = compareFilms(targetFilms, ourIndex);

  console.log("");
  const report = formatReport(targetFilms, matched, missing, cinemourData);
  console.log(report);

  const openingMissing = missing.filter((f) =>
    f.lists.has("openingThisWeek"),
  ).length;
  const nowShowingOnlyMissing = missing.length - openingMissing;

  writeCinemourBadge({ openingMissing, nowShowingOnlyMissing });

  if (missing.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
