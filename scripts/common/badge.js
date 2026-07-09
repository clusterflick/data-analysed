const fs = require("fs");
const path = require("path");

// Writes a shields.io "endpoint" badge JSON file to the output directory.
// See https://shields.io/badges/endpoint-badge — the README badges point at
// img.shields.io/endpoint?url=<raw gist url>, and the gist is refreshed from
// these files at the end of each compare run.
//
// Colour is decided by the *spread* of findings, not just the raw total: one
// badly-broken venue, or problems smeared across many venues, is worse than the
// same number of findings concentrated harmlessly. This mirrors the exit-code
// logic in each compare script so the badge and CI status can never disagree.
//
//   brightgreen — nothing wrong at all
//   red         — a critical finding, OR > MANY_VENUES venues affected,
//                 OR any single venue with > MANY_PER_VENUE findings
//   orange      — anything in between
const MANY_VENUES = 5;
const MANY_PER_VENUE = 5;

function pluralise(word, n) {
  if (n === 1) return word;
  if (/(?:ch|sh|s|x)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function pickColour({ total, venuesAffected, maxPerVenue, critical }) {
  if (critical > 0 || venuesAffected > MANY_VENUES || maxPerVenue > MANY_PER_VENUE) {
    return "red";
  }
  if (total === 0) return "brightgreen";
  return "orange";
}

// figures:
//   label          — badge left-hand text (matches the workflow name)
//   total          — total findings across all venues
//   venuesAffected — how many venues have at least one finding
//   maxPerVenue    — largest per-venue finding count
//   critical       — count of critical findings (forces red); optional
//   unit           — singular noun for a finding (e.g. "mismatch")
//   criticalUnit   — singular noun for a critical finding (e.g. "missing venue")
function writeBadge(filename, figures) {
  const {
    label,
    total,
    venuesAffected,
    maxPerVenue,
    critical = 0,
    unit = "mismatch",
    criticalUnit = "missing venue",
  } = figures;

  const colour = pickColour({ total, venuesAffected, maxPerVenue, critical });

  const parts = [];
  if (total > 0) {
    parts.push(
      `${total} ${pluralise(unit, total)} across ${venuesAffected} ${pluralise("venue", venuesAffected)}`,
    );
  }
  if (critical > 0) {
    parts.push(`${critical} ${pluralise(criticalUnit, critical)}`);
  }
  const message = parts.length > 0 ? parts.join(", ") : "all matching";

  const badge = { schemaVersion: 1, label, message, color: colour };

  const outputDir = path.join(__dirname, "..", "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, filename);
  fs.writeFileSync(outputPath, JSON.stringify(badge, null, 2));
  console.log(`Badge written to ${outputPath} (${colour}: "${message}")`);
  return outputPath;
}

module.exports = { writeBadge };
