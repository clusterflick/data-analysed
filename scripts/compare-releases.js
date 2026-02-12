const fs = require("fs");
const path = require("path");

const RESCHEDULE_TOLERANCE_MS = 60 * 60 * 1000; // 1 hour

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
// Local file loading
// ---------------------------------------------------------------------------

function loadVenueData(dir) {
  const venues = {};
  for (const file of fs.readdirSync(dir)) {
    venues[file] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
  }
  return venues;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function getFuturePerformances(showing, now) {
  return (showing.performances || []).filter(({ time }) => time > now);
}

function matchPerformances(latestPerfs, previousPerfs) {
  const rescheduled = [];
  const added = [];
  const removed = [];

  const usedLatest = new Set();
  const usedPrevious = new Set();

  // For each previous performance, find closest time match in latest
  for (let pi = 0; pi < previousPerfs.length; pi++) {
    const prev = previousPerfs[pi];
    let bestIdx = -1;
    let bestDelta = Infinity;

    for (let li = 0; li < latestPerfs.length; li++) {
      if (usedLatest.has(li)) continue;
      const delta = Math.abs(latestPerfs[li].time - prev.time);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = li;
      }
    }

    if (bestIdx >= 0 && bestDelta <= RESCHEDULE_TOLERANCE_MS) {
      usedLatest.add(bestIdx);
      usedPrevious.add(pi);
      const timeDelta = latestPerfs[bestIdx].time - prev.time;
      if (timeDelta !== 0) {
        rescheduled.push({
          previous: prev,
          latest: latestPerfs[bestIdx],
          timeDelta,
        });
      }
    }
  }

  for (let pi = 0; pi < previousPerfs.length; pi++) {
    if (!usedPrevious.has(pi)) removed.push(previousPerfs[pi]);
  }

  for (let li = 0; li < latestPerfs.length; li++) {
    if (!usedLatest.has(li)) added.push(latestPerfs[li]);
  }

  return { rescheduled, added, removed };
}

function compareTmdbMatch(latestShowing, previousShowing) {
  const result = { single: null, multiple: null };

  // Single movie match
  const prevTmdb = previousShowing.themoviedb;
  const currTmdb = latestShowing.themoviedb;

  if (!prevTmdb && currTmdb) {
    result.single = { type: "gained", current: currTmdb };
  } else if (prevTmdb && !currTmdb) {
    result.single = { type: "lost", previous: prevTmdb };
  } else if (prevTmdb && currTmdb && prevTmdb.id !== currTmdb.id) {
    result.single = {
      type: "changed",
      previous: prevTmdb,
      current: currTmdb,
    };
  }

  // Multiple movies match
  const prevTmdbs = previousShowing.themoviedbs || [];
  const currTmdbs = latestShowing.themoviedbs || [];
  const prevIds = new Set(prevTmdbs.map((t) => t.id));
  const currIds = new Set(currTmdbs.map((t) => t.id));

  const addedEntries = currTmdbs.filter((t) => !prevIds.has(t.id));
  const removedEntries = prevTmdbs.filter((t) => !currIds.has(t.id));

  if (prevTmdbs.length === 0 && currTmdbs.length > 0) {
    result.multiple = { type: "gained", current: currTmdbs };
  } else if (prevTmdbs.length > 0 && currTmdbs.length === 0) {
    result.multiple = { type: "lost", previous: prevTmdbs };
  } else if (addedEntries.length > 0 || removedEntries.length > 0) {
    result.multiple = {
      type: "changed",
      added: addedEntries,
      removed: removedEntries,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-venue comparison
// ---------------------------------------------------------------------------

function compareVenue(latestShowings, previousShowings, now) {
  const latestById = new Map();
  for (const s of latestShowings) latestById.set(s.showingId, s);

  const previousById = new Map();
  for (const s of previousShowings) previousById.set(s.showingId, s);

  const addedShowings = [];
  const removedShowings = [];
  const modifiedShowings = [];
  const tmdbChanges = [];

  let totalFuturePerfsAdded = 0;
  let totalFuturePerfsRemoved = 0;
  let totalRescheduled = 0;

  // Removed showings (in previous, not in latest)
  for (const [showingId, prev] of previousById) {
    if (latestById.has(showingId)) continue;

    const futurePerfs = getFuturePerformances(prev, now);
    // Only report removals that had future performances
    if (futurePerfs.length > 0) {
      const sorted = [...futurePerfs].sort((a, b) => a.time - b.time);
      removedShowings.push({
        showingId,
        title: prev.title,
        url: prev.url,
        futurePerformanceCount: futurePerfs.length,
        nextPerformance: sorted[0].time,
      });
      totalFuturePerfsRemoved += futurePerfs.length;
    }
  }

  // Added showings (in latest, not in previous)
  for (const [showingId, curr] of latestById) {
    if (previousById.has(showingId)) continue;

    const futurePerfs = getFuturePerformances(curr, now);
    const sorted = [...futurePerfs].sort((a, b) => a.time - b.time);
    addedShowings.push({
      showingId,
      title: curr.title,
      url: curr.url,
      futurePerformanceCount: futurePerfs.length,
      nextPerformance: sorted[0]?.time || null,
    });
  }

  // Modified showings (present in both)
  for (const [showingId, curr] of latestById) {
    const prev = previousById.get(showingId);
    if (!prev) continue;

    const currFuture = getFuturePerformances(curr, now);
    const prevFuture = getFuturePerformances(prev, now);
    const perfDiff = matchPerformances(currFuture, prevFuture);

    const metadata = {};
    if (curr.title !== prev.title) {
      metadata.titleChanged = { from: prev.title, to: curr.title };
    }
    if (curr.url !== prev.url) {
      metadata.urlChanged = { from: prev.url, to: curr.url };
    }
    if (curr.category !== prev.category) {
      metadata.categoryChanged = { from: prev.category, to: curr.category };
    }

    const tmdbDiff = compareTmdbMatch(curr, prev);
    if (tmdbDiff.single !== null || tmdbDiff.multiple !== null) {
      tmdbChanges.push({
        showingId,
        title: curr.title,
        category: curr.category,
        ...tmdbDiff,
      });
    }

    const hasMetadataChanges = Object.keys(metadata).length > 0;
    const hasPerfChanges =
      perfDiff.added.length > 0 || perfDiff.removed.length > 0;
    const hasSignificantReschedules = perfDiff.rescheduled.some(
      (m) => Math.abs(m.timeDelta) >= RESCHEDULE_TOLERANCE_MS,
    );

    if (hasMetadataChanges || hasPerfChanges || hasSignificantReschedules) {
      modifiedShowings.push({
        showingId,
        title: curr.title,
        url: curr.url,
        metadata,
        performances: {
          previousCount: prevFuture.length,
          currentCount: currFuture.length,
          added: perfDiff.added.map((p) => p.time),
          removed: perfDiff.removed.map((p) => p.time),
          rescheduled: perfDiff.rescheduled.length,
        },
      });
    }

    totalFuturePerfsAdded += perfDiff.added.length;
    totalFuturePerfsRemoved += perfDiff.removed.length;
    totalRescheduled += perfDiff.rescheduled.length;
  }

  // Sort removed showings by impact (most future performances first)
  removedShowings.sort(
    (a, b) => b.futurePerformanceCount - a.futurePerformanceCount,
  );

  // Count totals for the previous release (for percentage calculations)
  let previousFutureTotal = 0;
  for (const prev of previousById.values()) {
    previousFutureTotal += getFuturePerformances(prev, now).length;
  }

  return {
    showings: {
      added: addedShowings,
      removed: removedShowings,
      modified: modifiedShowings,
    },
    futurePerformances: {
      previousTotal: previousFutureTotal,
      added: totalFuturePerfsAdded,
      removed: totalFuturePerfsRemoved,
      rescheduled: totalRescheduled,
    },
    tmdbChanges,
  };
}

// ---------------------------------------------------------------------------
// Significance classification
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

function computeSummary(allVenueDiffs) {
  let totalVenues = 0;
  let venuesAdded = 0;
  let venuesRemoved = 0;
  let venuesEmpty = 0;
  let totalShowingsAdded = 0;
  let totalShowingsRemoved = 0;
  let totalFuturePerfsAdded = 0;
  let totalFuturePerfsRemoved = 0;
  let tmdbGained = 0;
  let tmdbLost = 0;
  let tmdbChanged = 0;

  for (const diff of Object.values(allVenueDiffs)) {
    totalVenues++;

    if (diff.venueAdded) {
      venuesAdded++;
      continue;
    }
    if (diff.venueRemoved) {
      venuesRemoved++;
      continue;
    }
    if (diff.venueEmpty) venuesEmpty++;

    totalShowingsAdded += diff.showings.added.length;
    totalShowingsRemoved += diff.showings.removed.length;
    totalFuturePerfsAdded += diff.futurePerformances.added;
    totalFuturePerfsRemoved += diff.futurePerformances.removed;

    for (const tc of diff.tmdbChanges) {
      if (tc.single) {
        if (tc.single.type === "gained") tmdbGained++;
        else if (tc.single.type === "lost") tmdbLost++;
        else if (tc.single.type === "changed") tmdbChanged++;
      }
      if (tc.multiple) {
        if (tc.multiple.type === "gained") tmdbGained++;
        else if (tc.multiple.type === "lost") tmdbLost++;
        else if (tc.multiple.type === "changed") tmdbChanged++;
      }
    }
  }

  return {
    totalVenues,
    venuesAdded,
    venuesRemoved,
    venuesEmpty,
    showingsAdded: totalShowingsAdded,
    showingsRemoved: totalShowingsRemoved,
    futurePerformancesAdded: totalFuturePerfsAdded,
    futurePerformancesRemoved: totalFuturePerfsRemoved,
    tmdbMatchesGained: tmdbGained,
    tmdbMatchesLost: tmdbLost,
    tmdbMatchesChanged: tmdbChanged,
  };
}

function formatVenueDetail(venueId, diff) {
  const lines = [];
  const clr = concernColor(diff.concern);

  lines.push(
    `${clr}--- ${venueId} ${"\u2500".repeat(Math.max(0, 55 - venueId.length))}${c.reset}`,
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

function formatReport(allVenueDiffs, currentTag, previousTag) {
  const lines = [];

  lines.push(`${c.bold}${c.cyan}Release Comparison${c.reset}`);
  lines.push(`  Current:  ${formatTag(currentTag)}`);
  lines.push(`  Previous: ${formatTag(previousTag)}`);
  lines.push("");

  const summary = computeSummary(allVenueDiffs);

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
// ---------------------------------------------------------------------------

function buildJsonLog(allVenueDiffs, currentTag, previousTag) {
  const summary = computeSummary(allVenueDiffs);

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
      currentRelease: currentTag,
      previousRelease: previousTag,
      analysedAt: new Date().toISOString(),
      venueCount: summary.totalVenues,
    },
    summary,
    venues,
  };
}

function writeJsonLog(allVenueDiffs, currentTag, previousTag) {
  const outputDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const data = buildJsonLog(allVenueDiffs, currentTag, previousTag);
  const outputPath = path.join(outputDir, `comparison-${currentTag}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`JSON log written to ${outputPath}`);

  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function compareReleases(currentDir, previousDir, currentTag, previousTag) {
  const now = Date.now();

  console.log(`Loading current release from ${currentDir}...`);
  const currentVenues = loadVenueData(currentDir);
  console.log(`  Found ${Object.keys(currentVenues).length} venue files`);

  console.log(`Loading previous release from ${previousDir}...`);
  const previousVenues = loadVenueData(previousDir);
  console.log(`  Found ${Object.keys(previousVenues).length} venue files`);

  const allVenueIds = new Set([
    ...Object.keys(currentVenues),
    ...Object.keys(previousVenues),
  ]);

  console.log(`\nComparing ${allVenueIds.size} venues...\n`);

  const allVenueDiffs = {};

  for (const venueId of [...allVenueIds].sort()) {
    const currData = currentVenues[venueId];
    const prevData = previousVenues[venueId];

    if (!prevData && currData) {
      allVenueDiffs[venueId] = {
        venueAdded: true,
        concern: "OK",
        showings: { added: [], removed: [], modified: [] },
        futurePerformances: {
          previousTotal: 0,
          added: 0,
          removed: 0,
          rescheduled: 0,
        },
        tmdbChanges: [],
      };
      continue;
    }

    if (prevData && !currData) {
      allVenueDiffs[venueId] = {
        venueRemoved: true,
        concern: "CRITICAL",
        showings: { added: [], removed: [], modified: [] },
        futurePerformances: {
          previousTotal: 0,
          added: 0,
          removed: 0,
          rescheduled: 0,
        },
        tmdbChanges: [],
      };
      continue;
    }

    const latestShowings = Array.isArray(currData) ? currData : [];
    const previousShowings = Array.isArray(prevData) ? prevData : [];

    const diff = compareVenue(latestShowings, previousShowings, now);

    if (previousShowings.length > 0 && latestShowings.length === 0) {
      diff.venueEmpty = true;
      diff.concern = "WARNING";
    } else {
      diff.concern = classifyChanges(diff);
    }

    allVenueDiffs[venueId] = diff;
  }

  const report = formatReport(allVenueDiffs, currentTag, previousTag);
  console.log(report);

  writeJsonLog(allVenueDiffs, currentTag, previousTag);

  // Exit with non-zero if any CRITICAL venues found
  const hasCritical = Object.values(allVenueDiffs).some(
    (d) => d.concern === "CRITICAL",
  );
  if (hasCritical) {
    console.log(
      `${c.bold}${c.red}Exiting with code 1 due to CRITICAL findings.${c.reset}`,
    );
    process.exit(1);
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

compareReleases(currentDir, previousDir, currentTag, previousTag);
