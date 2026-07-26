const fs = require("fs");
const path = require("path");
const { compareReleases: diffReleases } = require("scripts/scripts/diff");

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

function concernColor(level) {
  return (
    { CRITICAL: c.red, WARNING: c.yellow, OK: c.green, INFO: c.cyan }[level] ||
    c.dim
  );
}

function concernLabel(level) {
  return `${c.bold}${concernColor(level)}${level}${c.reset}`;
}

function colorNonZero(count, label, clr) {
  if (count === 0) return `${count} ${label}`;
  return `${clr}${count} ${label}${c.reset}`;
}

// ---------------------------------------------------------------------------
// Significance classification
//
// How much a change should worry us is a judgement for this report to make,
// not a property of the diff, so it lives here rather than in the shared core.
// ---------------------------------------------------------------------------

function classifyChanges(venueDiff) {
  const { showings, futurePerformances, tmdbChanges } = venueDiff;

  const removedPct =
    futurePerformances.previousTotal > 0
      ? futurePerformances.removed / futurePerformances.previousTotal
      : 0;

  if (removedPct > 0.5) return "CRITICAL";
  if (showings.removed.length > 0 || removedPct > 0.1) return "WARNING";

  const hasTmdbLoss = tmdbChanges.some(
    (tc) =>
      (tc.single &&
        (tc.single.type === "lost" || tc.single.type === "changed")) ||
      (tc.multiple && tc.multiple.type === "lost") ||
      (tc.multiple &&
        tc.multiple.type === "changed" &&
        tc.multiple.removed.length > 0),
  );
  if (hasTmdbLoss) return "WARNING";

  const hasAnyChanges =
    showings.added.length > 0 ||
    showings.modified.length > 0 ||
    tmdbChanges.length > 0;
  if (hasAnyChanges) return "OK";

  return "UNCHANGED";
}

function addConcernLevels(venues) {
  const withConcern = {};
  for (const [venueId, diff] of Object.entries(venues)) {
    let concern;
    if (diff.venueRemoved) concern = "CRITICAL";
    else if (diff.venueAdded) concern = "OK";
    else if (diff.venueEmpty) concern = "WARNING";
    else concern = classifyChanges(diff);

    withConcern[venueId] = { ...diff, concern };
  }
  return withConcern;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTag(tag) {
  const match = tag.match(/^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})$/);
  if (!match) return tag;
  const [, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T12:00:00Z`);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${tag} (${days[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${y})`;
}

function formatTime(timeMs) {
  const date = new Date(timeMs);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`;
}

function plural(count, word) {
  return `${count} ${word}${count !== 1 ? "s" : ""}`;
}

// ---------------------------------------------------------------------------
// Console report
// ---------------------------------------------------------------------------

function formatVenueDetail(venueId, diff) {
  const lines = [];
  const clr = concernColor(diff.concern);

  lines.push(
    `${clr}--- ${venueId} ${"─".repeat(Math.max(0, 55 - venueId.length))}${c.reset}`,
  );

  if (diff.venueRemoved) {
    lines.push(`    Concern: ${concernLabel("CRITICAL")}`);
    lines.push(`    ${c.red}Venue file missing from latest release${c.reset}`);
    lines.push("");
    return lines;
  }

  if (diff.venueAdded) {
    lines.push(`    Concern: ${concernLabel("INFO")}`);
    lines.push(`    ${c.green}New venue appeared in latest release${c.reset}`);
    lines.push("");
    return lines;
  }

  lines.push(`    Concern: ${concernLabel(diff.concern)}`);

  if (diff.venueEmpty) {
    lines.push(`    ${c.yellow}Venue has 0 showings (was non-zero)${c.reset}`);
  }

  const { showings, futurePerformances } = diff;

  if (showings.removed.length > 0 || showings.added.length > 0) {
    const parts = [];
    if (showings.removed.length > 0) {
      parts.push(
        `${c.red}${showings.removed.length} removed${c.reset} (all had future perfs)`,
      );
    }
    if (showings.added.length > 0) {
      parts.push(`${c.green}${showings.added.length} added${c.reset}`);
    }
    lines.push(`    Showings: ${parts.join(", ")}`);
  }

  if (futurePerformances.removed > 0 || futurePerformances.added > 0) {
    lines.push(
      `    Future performances: ${colorNonZero(futurePerformances.removed, "removed", c.red)}, ${colorNonZero(futurePerformances.added, "added", c.green)}`,
    );
  }

  // Removed showings detail
  if (showings.removed.length > 0) {
    lines.push("");
    lines.push(`    ${c.red}Removed showings:${c.reset}`);
    for (const s of showings.removed) {
      lines.push(`      "${s.title}" (${s.showingId})`);
      const nextStr = s.nextPerformance
        ? ` (next: ${formatTime(s.nextPerformance)})`
        : "";
      lines.push(
        `        Had ${plural(s.futurePerformanceCount, "future performance")}${nextStr}`,
      );
      lines.push(`        URL: ${s.url}`);
    }
  }

  // Added showings detail
  if (showings.added.length > 0) {
    lines.push("");
    lines.push(`    ${c.green}Added showings:${c.reset}`);
    for (const s of showings.added) {
      lines.push(`      "${s.title}" (${s.showingId})`);
      const nextStr = s.nextPerformance
        ? ` (next: ${formatTime(s.nextPerformance)})`
        : "";
      lines.push(
        `        ${plural(s.futurePerformanceCount, "future performance")}${nextStr}`,
      );
    }
  }

  // Modified showings detail
  const significantModified = showings.modified.filter(
    (s) =>
      s.performances.added.length > 0 ||
      s.performances.removed.length > 0 ||
      Object.keys(s.metadata).length > 0,
  );
  if (significantModified.length > 0) {
    lines.push("");
    lines.push(`    ${c.yellow}Modified showings:${c.reset}`);
    for (const s of significantModified) {
      lines.push(`      "${s.title}" (${s.showingId})`);
      if (s.metadata.titleChanged) {
        lines.push(
          `        Title: "${s.metadata.titleChanged.from}" -> "${s.metadata.titleChanged.to}"`,
        );
      }
      if (s.metadata.urlChanged) {
        lines.push("        URL changed");
      }
      if (s.metadata.categoryChanged) {
        lines.push(
          `        Category: ${s.metadata.categoryChanged.from} -> ${s.metadata.categoryChanged.to}`,
        );
      }
      if (
        s.performances.removed.length > 0 ||
        s.performances.added.length > 0
      ) {
        const reschedNote =
          s.performances.rescheduled > 0
            ? `, ${s.performances.rescheduled} rescheduled`
            : "";
        lines.push(
          `        Future performances: ${s.performances.previousCount} -> ${s.performances.currentCount} (${colorNonZero(s.performances.removed.length, "removed", c.red)}, ${colorNonZero(s.performances.added.length, "added", c.green)}${reschedNote})`,
        );
        for (const time of s.performances.removed) {
          lines.push(`          ${c.red}-${c.reset} ${formatTime(time)}`);
        }
        for (const time of s.performances.added) {
          lines.push(`          ${c.green}+${c.reset} ${formatTime(time)}`);
        }
        lines.push(`        URL: ${s.url}`);
      }
    }
  }

  // TMDB match changes
  if (diff.tmdbChanges.length > 0) {
    lines.push("");
    lines.push(`    ${c.cyan}TMDB match changes:${c.reset}`);
    for (const tc of diff.tmdbChanges) {
      const multiLabel =
        tc.category === "multiple-movies" ? " [multiple-movies]" : "";
      lines.push(`      "${tc.title}" (${tc.showingId})${multiLabel}`);

      if (tc.single) {
        if (tc.single.type === "gained") {
          lines.push(
            `        ${c.green}Gained match:${c.reset} "${tc.single.current.title}" (TMDB #${tc.single.current.id})`,
          );
        } else if (tc.single.type === "lost") {
          lines.push(
            `        ${c.red}Lost match:${c.reset} "${tc.single.previous.title}" (TMDB #${tc.single.previous.id})`,
          );
        } else if (tc.single.type === "changed") {
          lines.push(
            `        ${c.yellow}Match changed:${c.reset} "${tc.single.previous.title}" (TMDB #${tc.single.previous.id}) -> "${tc.single.current.title}" (TMDB #${tc.single.current.id})`,
          );
        }
      }

      if (tc.multiple) {
        if (tc.multiple.type === "gained") {
          for (const t of tc.multiple.current) {
            lines.push(
              `        ${c.green}Match added:${c.reset} "${t.title}" (TMDB #${t.id})`,
            );
          }
        } else if (tc.multiple.type === "lost") {
          for (const t of tc.multiple.previous) {
            lines.push(
              `        ${c.red}Match removed:${c.reset} "${t.title}" (TMDB #${t.id})`,
            );
          }
        } else if (tc.multiple.type === "changed") {
          for (const t of tc.multiple.removed) {
            lines.push(
              `        ${c.red}Match removed:${c.reset} "${t.title}" (TMDB #${t.id})`,
            );
          }
          for (const t of tc.multiple.added) {
            lines.push(
              `        ${c.green}Match added:${c.reset} "${t.title}" (TMDB #${t.id})`,
            );
          }
        }
      }
    }
  }

  lines.push("");
  return lines;
}

function formatReport(allVenueDiffs, summary, currentTag, previousTag) {
  const lines = [];

  lines.push(`${c.bold}${c.cyan}Release Comparison${c.reset}`);
  lines.push(`  Current:  ${formatTag(currentTag)}`);
  lines.push(`  Previous: ${formatTag(previousTag)}`);
  lines.push("");

  lines.push(`${c.bold}Summary${c.reset}`);
  const venueExtra =
    summary.venuesEmpty > 0
      ? `, ${c.yellow}${summary.venuesEmpty} empty${c.reset}`
      : "";
  lines.push(
    `  Venues analysed: ${summary.totalVenues} (${colorNonZero(summary.venuesAdded, "added", c.green)}, ${colorNonZero(summary.venuesRemoved, "removed", c.red)}${venueExtra})`,
  );
  lines.push(
    `  Showings: ${colorNonZero(summary.showingsRemoved, "removed", c.red)} (all had future performances), ${colorNonZero(summary.showingsAdded, "added", c.green)}`,
  );
  lines.push(
    `  Future performances: ${colorNonZero(summary.futurePerformancesRemoved, "removed", c.red)}, ${colorNonZero(summary.futurePerformancesAdded, "added", c.green)}`,
  );
  lines.push(
    `  TMDB matches: ${colorNonZero(summary.tmdbMatchesLost, "lost", c.red)}, ${colorNonZero(summary.tmdbMatchesChanged, "changed", c.yellow)}, ${colorNonZero(summary.tmdbMatchesGained, "gained", c.green)}`,
  );
  lines.push("");

  // Group venues by concern level
  const order = ["CRITICAL", "WARNING", "OK"];
  const concerned = [];
  const unchanged = [];

  for (const [venueId, diff] of Object.entries(allVenueDiffs)) {
    if (diff.concern === "UNCHANGED") {
      unchanged.push(venueId);
    } else {
      concerned.push({ venueId, diff });
    }
  }

  // Sort concerned venues: CRITICAL first, then WARNING, then OK
  concerned.sort((a, b) => {
    const ai = order.indexOf(a.diff.concern);
    const bi = order.indexOf(b.diff.concern);
    if (ai !== bi) return ai - bi;
    return a.venueId.localeCompare(b.venueId);
  });

  if (concerned.length === 0) {
    lines.push(`${c.green}No venues with concerns.${c.reset}`);
    lines.push("");
  } else {
    lines.push(
      `${c.bold}Venues with concerns (${concerned.length} of ${summary.totalVenues})${c.reset}`,
    );
    lines.push("");

    for (const { venueId, diff } of concerned) {
      lines.push(...formatVenueDetail(venueId, diff));
    }
  }

  if (unchanged.length > 0) {
    unchanged.sort();
    lines.push(
      `${c.dim}Unchanged venues (${unchanged.length}): ${unchanged.join(", ")}${c.reset}`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON log output
//
// The published diff blob (see data-diffed) drops unchanged venues and the
// concern levels; this log keeps both, because triaging a run is exactly what
// it is for.
// ---------------------------------------------------------------------------

function buildJsonLog(allVenueDiffs, metadata, summary) {
  const venues = {};
  for (const [venueId, diff] of Object.entries(allVenueDiffs)) {
    if (diff.venueAdded) {
      venues[venueId] = { concern: "OK", venueAdded: true };
      continue;
    }
    if (diff.venueRemoved) {
      venues[venueId] = { concern: "CRITICAL", venueRemoved: true };
      continue;
    }

    const tmdbByType = { gained: [], lost: [], changed: [] };
    for (const tc of diff.tmdbChanges) {
      if (tc.single) tmdbByType[tc.single.type].push(tc);
      if (tc.multiple) tmdbByType[tc.multiple.type].push(tc);
    }

    venues[venueId] = {
      concern: diff.concern,
      venueEmpty: diff.venueEmpty || false,
      showings: diff.showings,
      futurePerformances: diff.futurePerformances,
      tmdbChanges: tmdbByType,
    };
  }

  return {
    metadata: {
      currentRelease: metadata.currentRelease,
      previousRelease: metadata.previousRelease,
      analysedAt: metadata.diffedAt,
      venueCount: summary.totalVenues,
    },
    summary,
    venues,
  };
}

function writeJsonLog(allVenueDiffs, metadata, summary) {
  const outputDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const data = buildJsonLog(allVenueDiffs, metadata, summary);
  const outputPath = path.join(
    outputDir,
    `comparison-${metadata.currentRelease}.json`,
  );
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`JSON log written to ${outputPath}`);

  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function compareReleases(
  currentDir,
  previousDir,
  currentTag,
  previousTag,
) {
  const { metadata, summary, venues } = await diffReleases({
    currentDir,
    previousDir,
    currentTag,
    previousTag,
  });

  const allVenueDiffs = addConcernLevels(venues);

  console.log(formatReport(allVenueDiffs, summary, currentTag, previousTag));

  writeJsonLog(allVenueDiffs, metadata, summary);

  // Exit with non-zero if any CRITICAL venues found
  const hasCritical = Object.values(allVenueDiffs).some(
    (d) => d.concern === "CRITICAL",
  );
  if (hasCritical) {
    console.log(
      `${c.bold}${c.red}Exiting with code 1 due to CRITICAL findings.${c.reset}`,
    );
    process.exitCode = 1;
  }
}

const [currentDir, previousDir, currentTag, previousTag] =
  process.argv.slice(2);

if (!currentDir || !previousDir || !currentTag || !previousTag) {
  console.error(
    "Usage: compare-releases.js <current-dir> <previous-dir> <current-tag> <previous-tag>",
  );
  process.exit(1);
}

compareReleases(currentDir, previousDir, currentTag, previousTag).catch(
  (error) => {
    console.error(`\n❌ ${error.stack || error.message || error}`);
    process.exit(1);
  },
);
