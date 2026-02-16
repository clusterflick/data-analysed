const fs = require("fs");
const path = require("path");
const { getAttributesFor } = require("./utils");

const TIME_TOLERANCE_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// ANSI colors (same palette as compare-releases.js)
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
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

// ---------------------------------------------------------------------------
// Accessibility tag mapping
// ---------------------------------------------------------------------------

const UKCA_TAG_MAP = {
  "Showtime.Accessibility.AudioDescription": "audioDescription",
  "Showtime.Accessibility.AutismFriendly": "relaxed",
  "Showtime.Accessibility.DementiaFriendly": "relaxed",
  "Showtime.Accessibility.Subtitled": "subtitled",
  "Showtime.Accessibility.ClosedCaption": "hardOfHearing",
  "Showtime.Accessibility.OpenCaption": "subtitled",
};

function ukcaTagsToAccessibility(tags) {
  const result = {};
  const unknownTags = [];

  for (const tag of tags) {
    if (!tag.startsWith("Showtime.Accessibility.")) continue;
    if (tag === "Showtime.Accessibility.Accessible") continue;

    const field = UKCA_TAG_MAP[tag];
    if (field) {
      result[field] = true;
    } else {
      unknownTags.push(tag);
    }
  }

  return { accessibility: result, unknownTags };
}

function hasAccessibilityTags(tags) {
  return tags.some(
    (t) =>
      t.startsWith("Showtime.Accessibility.") &&
      t !== "Showtime.Accessibility.Accessible",
  );
}

// ---------------------------------------------------------------------------
// Haversine distance (km)
// ---------------------------------------------------------------------------

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Name similarity
// ---------------------------------------------------------------------------

const VENUE_NOISE_WORDS = new Set(["cinema", "london", "the"]);

function normalizeVenueName(name) {
  return name
    .toLowerCase()
    .replace(/[''\u2019]s\b/g, "s") // strip possessives
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !VENUE_NOISE_WORDS.has(w))
    .join(" ");
}

function venueNameSimilarity(a, b) {
  const na = normalizeVenueName(a);
  const nb = normalizeVenueName(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// Performance title similarity — lighter normalisation (no noise-word stripping)
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadUkcaData(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return raw;
}

function loadTransformedData(dir) {
  const venues = {};
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    try {
      venues[file] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // Skip non-JSON files
    }
  }
  return venues;
}

function getVenueGeo(venueId) {
  try {
    const attrs = getAttributesFor(venueId);
    if (attrs && attrs.geo) {
      return { lat: attrs.geo.lat, lon: attrs.geo.lon };
    }
  } catch {
    // Venue not found in scripts package
  }
  return null;
}

function getVenueName(venueId) {
  try {
    const attrs = getAttributesFor(venueId);
    if (attrs && attrs.name) return attrs.name;
  } catch {
    // Venue not found
  }
  return venueId;
}

// ---------------------------------------------------------------------------
// Step 1: Venue matching
// ---------------------------------------------------------------------------

function extractShortId(base64Id) {
  const decoded = Buffer.from(base64Id, "base64").toString("utf-8");
  const parts = decoded.split(":");
  return parts.length > 1 ? parts[1] : decoded;
}

const COORD_THRESHOLD_KM = 0.25;

function matchVenues(ukcaTheaters, transformedVenues) {
  const venueIds = Object.keys(transformedVenues);

  // Step 1: Build all candidate pairs within 250m
  const candidates = [];
  for (const theater of ukcaTheaters) {
    const ukcaLat = theater.coordinates?.latitude;
    const ukcaLon = theater.coordinates?.longitude;
    if (!ukcaLat || !ukcaLon) continue;

    for (const venueId of venueIds) {
      const geo = getVenueGeo(venueId);
      if (!geo) continue;

      const dist = haversineKm(ukcaLat, ukcaLon, geo.lat, geo.lon);
      if (dist >= COORD_THRESHOLD_KM) continue;

      const ourName = getVenueName(venueId);
      const sim = venueNameSimilarity(theater.name, ourName);
      candidates.push({ theater, venueId, dist, nameSim: sim });
    }
  }

  // Step 2: Sort by name similarity desc, then distance asc
  candidates.sort((a, b) => b.nameSim - a.nameSim || a.dist - b.dist);

  // Step 3: Greedily assign best-first
  const matched = [];
  const matchedUkcaIds = new Set();
  const usedVenues = new Set();

  for (const c of candidates) {
    if (matchedUkcaIds.has(c.theater.id)) continue;
    if (usedVenues.has(c.venueId)) continue;

    matched.push({
      ukcaTheater: c.theater,
      venueId: c.venueId,
      matchDist: c.dist,
      matchNameSim: c.nameSim,
    });
    matchedUkcaIds.add(c.theater.id);
    usedVenues.add(c.venueId);
  }

  // Step 4: Name-only fallback for remaining unmatched
  const NAME_FALLBACK_THRESHOLD = 0.5;
  const nameFallbackCandidates = [];

  for (const theater of ukcaTheaters) {
    if (matchedUkcaIds.has(theater.id)) continue;

    for (const venueId of venueIds) {
      if (usedVenues.has(venueId)) continue;
      const ourName = getVenueName(venueId);
      const sim = venueNameSimilarity(theater.name, ourName);
      if (sim >= NAME_FALLBACK_THRESHOLD) {
        nameFallbackCandidates.push({ theater, venueId, nameSim: sim });
      }
    }
  }

  nameFallbackCandidates.sort((a, b) => b.nameSim - a.nameSim);

  for (const c of nameFallbackCandidates) {
    if (matchedUkcaIds.has(c.theater.id)) continue;
    if (usedVenues.has(c.venueId)) continue;

    const ukcaLat = c.theater.coordinates?.latitude;
    const ukcaLon = c.theater.coordinates?.longitude;
    const geo = getVenueGeo(c.venueId);
    const dist =
      geo && ukcaLat && ukcaLon
        ? haversineKm(ukcaLat, ukcaLon, geo.lat, geo.lon)
        : null;

    matched.push({
      ukcaTheater: c.theater,
      venueId: c.venueId,
      matchDist: dist,
      matchNameSim: c.nameSim,
    });
    matchedUkcaIds.add(c.theater.id);
    usedVenues.add(c.venueId);
  }

  // Unmatched UKCA theaters — find nearest venue for diagnostics
  const unmatchedUkca = [];
  for (const theater of ukcaTheaters) {
    if (matchedUkcaIds.has(theater.id)) continue;
    const ukcaLat = theater.coordinates?.latitude;
    const ukcaLon = theater.coordinates?.longitude;

    let nearest = null;
    let nearestDist = Infinity;
    for (const venueId of venueIds) {
      const geo = getVenueGeo(venueId);
      if (!geo || !ukcaLat || !ukcaLon) continue;
      const dist = haversineKm(ukcaLat, ukcaLon, geo.lat, geo.lon);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { venueId, dist };
      }
    }
    unmatchedUkca.push({ theater, nearest });
  }

  const unmatchedOurs = venueIds.filter((v) => !usedVenues.has(v)).sort();

  return { matched, unmatchedUkca, unmatchedOurs };
}

// ---------------------------------------------------------------------------
// Step 2: Performance matching
// ---------------------------------------------------------------------------

function flattenUkcaShowtimes(showtimeData) {
  const flat = [];
  if (!Array.isArray(showtimeData)) return flat;

  for (const movieEntry of showtimeData) {
    const movieTitle =
      movieEntry.movie?.en_GB?.title ||
      movieEntry.movie?.fallback?.title ||
      movieEntry.movie?.originalTitle ||
      "Unknown";

    for (const st of movieEntry.showtimes || []) {
      const bookingUrls = [];
      for (const t of st.data?.ticketing || []) {
        bookingUrls.push(...(t.urls || []));
      }

      flat.push({
        movieTitle,
        startsAt: st.startsAt,
        startsAtMs: new Date(st.startsAt.replace(" ", "T") + "Z").getTime(),
        tags: st.tags || [],
        bookingUrls,
      });
    }
  }

  return flat;
}

function flattenOurPerformances(showings) {
  const flat = [];
  if (!Array.isArray(showings)) return flat;

  for (const showing of showings) {
    for (const perf of showing.performances || []) {
      flat.push({
        showingTitle: showing.title,
        showingId: showing.showingId,
        time: perf.time,
        bookingUrl: perf.bookingUrl,
        accessibility: perf.accessibility || {},
        screen: perf.screen || null,
      });
    }
  }

  return flat;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    u.search = "";
    for (const [k, v] of params) u.searchParams.set(k, v);
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function matchPerformances(ukcaFlat, ourFlat) {
  const matchedPerfs = [];
  const ukcaOnly = [];
  const ourOnly = [];

  const usedOurIdx = new Set();
  const usedUkcaIdx = new Set();

  // Build normalized URL lookup for our performances
  const ourNormUrls = ourFlat.map((o) =>
    o.bookingUrl ? normalizeUrl(o.bookingUrl) : null,
  );

  // Primary: match by booking URL (normalized)
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    const ukca = ukcaFlat[ui];
    if (usedUkcaIdx.has(ui)) continue;

    const ukcaNormUrls = ukca.bookingUrls.map(normalizeUrl);

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      if (!ourNormUrls[oi]) continue;

      if (ukcaNormUrls.some((u) => u === ourNormUrls[oi])) {
        usedUkcaIdx.add(ui);
        usedOurIdx.add(oi);
        matchedPerfs.push({
          ukca,
          ours: ourFlat[oi],
          matchMethod: "bookingUrl",
        });
        break;
      }
    }
  }

  // Fallback: match by title + time within tolerance
  // Title similarity is required (>= 0.3) — time alone cannot identify a
  // performance since multi-screen cinemas have different films at the same time.
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    if (usedUkcaIdx.has(ui)) continue;
    const ukca = ukcaFlat[ui];

    let bestOurIdx = -1;
    let bestTitleSim = 0;
    let bestDelta = Infinity;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      const delta = Math.abs(ukca.startsAtMs - ourFlat[oi].time);
      if (delta > TIME_TOLERANCE_MS) continue;

      const titleSim = nameSimilarity(
        ukca.movieTitle,
        ourFlat[oi].showingTitle,
      );
      if (titleSim < 0.3) continue;

      // Pick best title match; use time as tiebreaker
      if (
        titleSim > bestTitleSim ||
        (titleSim === bestTitleSim && delta < bestDelta)
      ) {
        bestTitleSim = titleSim;
        bestDelta = delta;
        bestOurIdx = oi;
      }
    }

    if (bestOurIdx >= 0) {
      usedUkcaIdx.add(ui);
      usedOurIdx.add(bestOurIdx);
      matchedPerfs.push({
        ukca,
        ours: ourFlat[bestOurIdx],
        matchMethod: "time",
      });
    }
  }

  // Remaining unmatched
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    if (!usedUkcaIdx.has(ui)) ukcaOnly.push(ukcaFlat[ui]);
  }
  for (let oi = 0; oi < ourFlat.length; oi++) {
    if (!usedOurIdx.has(oi)) ourOnly.push(ourFlat[oi]);
  }

  return { matchedPerfs, ukcaOnly, ourOnly };
}

// ---------------------------------------------------------------------------
// Step 2b: Accessibility comparison
// ---------------------------------------------------------------------------

function compareAccessibility(ukcaTags, ourAccessibility) {
  const { accessibility: ukcaAccess, unknownTags } =
    ukcaTagsToAccessibility(ukcaTags);

  const mismatches = [];
  const allFields = [
    "audioDescription",
    "babyFriendly",
    "hardOfHearing",
    "relaxed",
    "subtitled",
  ];

  for (const field of allFields) {
    const ukcaHas = ukcaAccess[field] === true;
    const ourHas = ourAccessibility[field] === true;

    if (ukcaHas && !ourHas) {
      mismatches.push({ field, type: "missing-in-ours" });
    } else if (!ukcaHas && ourHas) {
      mismatches.push({ field, type: "extra-in-ours" });
    }
  }

  return { mismatches, unknownTags, ukcaAccess, ourAccess: ourAccessibility };
}

// ---------------------------------------------------------------------------
// Per-venue analysis
// ---------------------------------------------------------------------------

function analyzeVenue(ukcaShowtimeData, ourShowings, now) {
  const nowMs = now.getTime();
  const ukcaFlat = flattenUkcaShowtimes(ukcaShowtimeData).filter(
    (p) => p.startsAtMs >= nowMs,
  );
  const ourFlat = flattenOurPerformances(ourShowings).filter(
    (p) => p.time >= nowMs,
  );

  const { matchedPerfs, ukcaOnly, ourOnly } = matchPerformances(
    ukcaFlat,
    ourFlat,
  );

  // Analyse accessibility on matched performances
  const accessibilityConsistent = [];
  const accessibilityMismatch = [];
  const allUnknownTags = new Set();

  for (const match of matchedPerfs) {
    if (!hasAccessibilityTags(match.ukca.tags)) continue;

    const comparison = compareAccessibility(
      match.ukca.tags,
      match.ours.accessibility,
    );
    for (const t of comparison.unknownTags) allUnknownTags.add(t);

    if (comparison.mismatches.length === 0) {
      accessibilityConsistent.push(match);
    } else {
      accessibilityMismatch.push({
        ...match,
        mismatches: comparison.mismatches,
        ukcaAccess: comparison.ukcaAccess,
        ourAccess: comparison.ourAccess,
      });
    }
  }

  // UKCA-only accessible performances (ones we don't have at all)
  const ukcaOnlyAccessible = ukcaOnly.filter((u) =>
    hasAccessibilityTags(u.tags),
  );

  return {
    totalUkca: ukcaFlat.length,
    totalOurs: ourFlat.length,
    matchedCount: matchedPerfs.length,
    ukcaOnlyCount: ukcaOnly.length,
    ourOnlyCount: ourOnly.length,
    accessibilityConsistent: accessibilityConsistent.length,
    accessibilityMismatch,
    ukcaOnlyAccessible,
    unknownTags: [...allUnknownTags],
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatTime(ms) {
  const d = new Date(ms);
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
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${h}:${m}`;
}

function formatReport(venueMatchResult, venueAnalyses, ukcaData) {
  const lines = [];
  const { matched, unmatchedUkca, unmatchedOurs } = venueMatchResult;

  lines.push(`${c.bold}${c.cyan}Accessible Screenings Comparison${c.reset}`);
  lines.push(`  UKCA data fetched: ${ukcaData.metadata.fetchedAt}`);
  lines.push("");

  // Summary
  lines.push(`${c.bold}Venue Matching${c.reset}`);
  lines.push(`  UKCA theaters:          ${ukcaData.theaters.length}`);
  lines.push(`  Matched to our venues:  ${c.green}${matched.length}${c.reset}`);
  lines.push(
    `  Unmatched UKCA:         ${unmatchedUkca.length > 0 ? c.yellow : ""}${unmatchedUkca.length}${c.reset}`,
  );
  lines.push(
    `  Our venues (no UKCA):   ${c.dim}${unmatchedOurs.length}${c.reset}`,
  );
  lines.push("");

  // Performance summary
  let totalMatched = 0;
  let totalMismatches = 0;
  let totalConsistent = 0;
  let totalUkcaOnlyAccessible = 0;
  const allUnknownTags = new Set();

  for (const [, analysis] of Object.entries(venueAnalyses)) {
    totalMatched += analysis.matchedCount;
    totalMismatches += analysis.accessibilityMismatch.length;
    totalConsistent += analysis.accessibilityConsistent;
    totalUkcaOnlyAccessible += analysis.ukcaOnlyAccessible.length;
    for (const t of analysis.unknownTags) allUnknownTags.add(t);
  }

  lines.push(`${c.bold}Performance Matching (across matched venues)${c.reset}`);
  lines.push(`  Performances matched:         ${totalMatched}`);
  lines.push(
    `  Accessibility consistent:     ${c.green}${totalConsistent}${c.reset}`,
  );
  lines.push(
    `  Accessibility mismatches:     ${totalMismatches > 0 ? c.yellow : ""}${totalMismatches}${c.reset}`,
  );
  lines.push(
    `  UKCA-only accessible perfs:   ${totalUkcaOnlyAccessible > 0 ? c.red : ""}${totalUkcaOnlyAccessible}${c.reset}`,
  );
  lines.push("");

  if (allUnknownTags.size > 0) {
    lines.push(
      `${c.yellow}Unknown UKCA tags encountered:${c.reset} ${[...allUnknownTags].join(", ")}`,
    );
    lines.push("");
  }

  // CRITICAL: Unmatched UKCA theaters
  if (unmatchedUkca.length > 0) {
    lines.push(
      `${c.bold}${c.red}Unmatched UKCA Theaters (${unmatchedUkca.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}These UKCA theaters could not be matched to any of our venues.${c.reset}`,
    );
    lines.push(
      `${c.dim}They may represent new venue opportunities or matching failures.${c.reset}`,
    );
    lines.push("");

    for (const { theater, nearest } of unmatchedUkca) {
      const hasDates =
        theater.showtimesDates && theater.showtimesDates.length > 0;
      const dateNote = hasDates
        ? `${theater.showtimesDates.length} showtime dates`
        : "no upcoming showtimes";
      lines.push(`  ${c.yellow}${theater.name}${c.reset} (${dateNote})`);
      lines.push(
        `    Location: ${theater.location?.city || "?"}, ${theater.location?.zip || "?"}`,
      );
      if (theater.coordinates) {
        lines.push(
          `    Coords: ${theater.coordinates.latitude}, ${theater.coordinates.longitude}`,
        );
      }
      if (theater.url) {
        lines.push(`    URL: ${theater.url}`);
      }
      if (nearest) {
        lines.push(
          `    ${c.dim}Nearest: ${nearest.venueId} (${nearest.dist.toFixed(2)}km)${c.reset}`,
        );
      }
      lines.push("");
    }
  }

  // WARNING: Venues with accessibility mismatches
  const venuesWithMismatches = matched
    .filter((m) => {
      const analysis = venueAnalyses[m.venueId];
      return (
        analysis &&
        (analysis.accessibilityMismatch.length > 0 ||
          analysis.ukcaOnlyAccessible.length > 0)
      );
    })
    .sort((a, b) => {
      const aa = venueAnalyses[a.venueId];
      const ba = venueAnalyses[b.venueId];
      return (
        ba.accessibilityMismatch.length +
        ba.ukcaOnlyAccessible.length -
        (aa.accessibilityMismatch.length + aa.ukcaOnlyAccessible.length)
      );
    });

  if (venuesWithMismatches.length > 0) {
    lines.push(
      `${c.bold}${c.yellow}Venues with Accessibility Gaps (${venuesWithMismatches.length})${c.reset}`,
    );
    lines.push("");

    for (const m of venuesWithMismatches) {
      const analysis = venueAnalyses[m.venueId];
      lines.push(
        `${c.yellow}--- ${m.venueId} (${m.ukcaTheater.name}) ${"─".repeat(Math.max(0, 40 - m.venueId.length))}${c.reset}`,
      );
      lines.push(
        `    Match: ${m.matchDist != null ? m.matchDist.toFixed(2) + "km" : "name-only"}, name: ${m.matchNameSim.toFixed(2)}`,
      );
      const ukcaOnlyN = analysis.ukcaOnlyCount;
      const ourOnlyN = analysis.ourOnlyCount;
      const extras = [];
      if (ukcaOnlyN > 0) extras.push(`${ukcaOnlyN} UKCA-only`);
      if (ourOnlyN > 0) extras.push(`${ourOnlyN} ours-only`);
      const extraStr = extras.length > 0 ? ` — ${extras.join(", ")}` : "";
      lines.push(
        `    Performances: ${analysis.matchedCount} matched (of ${analysis.totalUkca} UKCA, ${analysis.totalOurs} ours)${extraStr}`,
      );

      const infoParts = [];
      if (analysis.screenLevelAdCount) {
        infoParts.push(
          `${analysis.screenLevelAdCount} UKCA screen-level AD (not per-showing)`,
        );
      }
      if (analysis.extraOnlyCount) {
        infoParts.push(
          `${analysis.extraOnlyCount} where we have extra tags UKCA lacks`,
        );
      }
      if (infoParts.length > 0) {
        lines.push(
          `    ${c.cyan}Info:${c.reset} ${c.dim}${infoParts.join("; ")}${c.reset}`,
        );
      }

      if (analysis.accessibilityMismatch.length > 0) {
        lines.push("");
        lines.push(
          `    ${c.yellow}Accessibility mismatches (${analysis.accessibilityMismatch.length}):${c.reset}`,
        );

        for (const mm of analysis.accessibilityMismatch.slice(0, 10)) {
          const time = formatTime(mm.ours.time);
          const method = mm.matchMethod === "bookingUrl" ? "url" : "time";
          lines.push(
            `      ${mm.ukca.movieTitle} @ ${time} ${c.dim}[${method}]${c.reset}`,
          );
          if (mm.ours.bookingUrl) {
            lines.push(`        ${c.dim}Ours:${c.reset} ${mm.ours.bookingUrl}`);
          }
          if (mm.ukca.bookingUrls.length > 0) {
            lines.push(
              `        ${c.dim}UKCA:${c.reset} ${mm.ukca.bookingUrls[0]}`,
            );
          }
          for (const mis of mm.mismatches) {
            if (mis.type === "missing-in-ours") {
              lines.push(
                `        ${c.red}Missing:${c.reset} ${mis.field} (UKCA has it, we don't)`,
              );
            } else {
              lines.push(
                `        ${c.cyan}Extra:${c.reset} ${mis.field} (we have it, UKCA doesn't)`,
              );
            }
          }
        }
        if (analysis.accessibilityMismatch.length > 10) {
          lines.push(
            `      ${c.dim}... and ${analysis.accessibilityMismatch.length - 10} more${c.reset}`,
          );
        }
      }

      if (analysis.ukcaOnlyAccessible.length > 0) {
        lines.push("");
        lines.push(
          `    ${c.red}UKCA-only accessible performances (${analysis.ukcaOnlyAccessible.length}):${c.reset}`,
        );
        for (const u of analysis.ukcaOnlyAccessible.slice(0, 10)) {
          const { accessibility: acc } = ukcaTagsToAccessibility(u.tags);
          const flags = Object.keys(acc).join(", ");
          lines.push(`      ${u.movieTitle} @ ${u.startsAt} [${flags}]`);
          if (u.bookingUrls.length > 0) {
            lines.push(`        ${c.dim}${u.bookingUrls[0]}${c.reset}`);
          }
        }
        if (analysis.ukcaOnlyAccessible.length > 10) {
          lines.push(
            `      ${c.dim}... and ${analysis.ukcaOnlyAccessible.length - 10} more${c.reset}`,
          );
        }
      }

      lines.push("");
    }
  }

  // INFO: Matched venues that are all consistent
  const venuesAllGood = matched.filter((m) => {
    const analysis = venueAnalyses[m.venueId];
    return (
      analysis &&
      analysis.accessibilityMismatch.length === 0 &&
      analysis.ukcaOnlyAccessible.length === 0
    );
  });

  if (venuesAllGood.length > 0) {
    lines.push(
      `${c.bold}${c.green}Venues with No Accessibility Gaps (${venuesAllGood.length})${c.reset}`,
    );
    for (const m of venuesAllGood) {
      const analysis = venueAnalyses[m.venueId];
      const notes = [];
      if (analysis.screenLevelAdCount)
        notes.push(`${analysis.screenLevelAdCount} screen-level AD`);
      if (analysis.extraOnlyCount)
        notes.push(`${analysis.extraOnlyCount} extra-in-ours`);
      const noteStr = notes.length
        ? ` ${c.dim}(${notes.join(", ")} ignored)${c.reset}`
        : "";
      lines.push(
        `  ${c.green}✓${c.reset} ${m.venueId} (${m.ukcaTheater.name}) - ${analysis.matchedCount} matched, ${analysis.accessibilityConsistent} consistent${noteStr}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON log
// ---------------------------------------------------------------------------

function buildJsonLog(venueMatchResult, venueAnalyses, ukcaData) {
  const { matched, unmatchedUkca, unmatchedOurs } = venueMatchResult;

  let totalMatched = 0;
  let totalMismatches = 0;
  let totalConsistent = 0;
  let totalUkcaOnlyAccessible = 0;

  for (const analysis of Object.values(venueAnalyses)) {
    totalMatched += analysis.matchedCount;
    totalMismatches += analysis.accessibilityMismatch.length;
    totalConsistent += analysis.accessibilityConsistent;
    totalUkcaOnlyAccessible += analysis.ukcaOnlyAccessible.length;
  }

  return {
    metadata: {
      analysedAt: new Date().toISOString(),
      ukcaFetchedAt: ukcaData.metadata.fetchedAt,
      ukcaTheaterCount: ukcaData.theaters.length,
    },
    summary: {
      venuesMatched: matched.length,
      venuesUnmatchedUkca: unmatchedUkca.length,
      venuesUnmatchedOurs: unmatchedOurs.length,
      performancesMatched: totalMatched,
      accessibilityConsistent: totalConsistent,
      accessibilityMismatches: totalMismatches,
      ukcaOnlyAccessiblePerformances: totalUkcaOnlyAccessible,
    },
    unmatchedUkcaTheaters: unmatchedUkca.map(({ theater, nearest }) => ({
      name: theater.name,
      location: theater.location,
      coordinates: theater.coordinates,
      tags: theater.tags?.list || [],
      url: theater.url,
      showtimeDateCount: theater.showtimesDates?.length || 0,
      nearest: nearest
        ? {
            venueId: nearest.venueId,
            dist: nearest.dist,
          }
        : null,
    })),
    venues: Object.fromEntries(
      matched.map((m) => {
        const analysis = venueAnalyses[m.venueId];
        return [
          m.venueId,
          {
            ukcaName: m.ukcaTheater.name,
            matchDist: m.matchDist,
            matchNameSim: m.matchNameSim,
            ...analysis,
            accessibilityMismatch: analysis.accessibilityMismatch.map((mm) => ({
              movieTitle: mm.ukca.movieTitle,
              startsAt: mm.ukca.startsAt,
              ourTime: mm.ours.time,
              matchMethod: mm.matchMethod,
              ourBookingUrl: mm.ours.bookingUrl || null,
              ukcaBookingUrls: mm.ukca.bookingUrls,
              mismatches: mm.mismatches,
              ukcaAccess: mm.ukcaAccess,
              ourAccess: mm.ourAccess,
            })),
            ukcaOnlyAccessible: analysis.ukcaOnlyAccessible.map((u) => ({
              movieTitle: u.movieTitle,
              startsAt: u.startsAt,
              tags: u.tags.filter((t) =>
                t.startsWith("Showtime.Accessibility."),
              ),
            })),
          },
        ];
      }),
    ),
  };
}

function writeJsonLog(venueMatchResult, venueAnalyses, ukcaData) {
  const outputDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const data = buildJsonLog(venueMatchResult, venueAnalyses, ukcaData);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(
    outputDir,
    `accessible-screenings-comparison-${timestamp}.json`,
  );
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`JSON log written to ${outputPath}`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const [ukcaDataPath, transformedDir] = process.argv.slice(2);

  if (!ukcaDataPath || !transformedDir) {
    console.error(
      "Usage: compare-accessible-screenings.js <ukca-data-path> <transformed-data-dir>",
    );
    process.exit(1);
  }

  console.log(`Loading UKCA data from ${ukcaDataPath}...`);
  const ukcaData = loadUkcaData(ukcaDataPath);
  console.log(`  ${ukcaData.theaters.length} theaters`);

  console.log(`Loading transformed data from ${transformedDir}...`);
  const transformedVenues = loadTransformedData(transformedDir);
  console.log(`  ${Object.keys(transformedVenues).length} venue files`);

  // Step 1: Match venues
  console.log("\nMatching venues...");
  const venueMatchResult = matchVenues(ukcaData.theaters, transformedVenues);
  console.log(`  Matched: ${venueMatchResult.matched.length}`);
  console.log(`  Unmatched UKCA: ${venueMatchResult.unmatchedUkca.length}`);
  console.log(`  Unmatched ours: ${venueMatchResult.unmatchedOurs.length}`);

  // Step 2: Analyse performances per matched venue (future only)
  const now = new Date();
  console.log(`\nAnalysing performances (from ${now.toISOString()})...`);
  const venueAnalyses = {};

  for (const m of venueMatchResult.matched) {
    const shortId = extractShortId(m.ukcaTheater.id);
    const ukcaShowtimeData = ukcaData.showtimes[shortId] || [];
    const ourShowings = transformedVenues[m.venueId] || [];

    const analysis = analyzeVenue(ukcaShowtimeData, ourShowings, now);

    // Detect screen-level AD: UKCA tags showtimes as AudioDescription based on
    // screen capability, not per-showing data. If a mismatch is only "missing
    // audioDescription" and the performance's screen has AUDIO_DESCRIPTION in
    // the UKCA theater data, it's a screen-level capability, not a real gap.
    const screens = m.ukcaTheater.screens || [];
    const adScreenNames = new Set(
      screens
        .filter((s) => s.accessibility?.includes("AUDIO_DESCRIPTION"))
        .map((s) => s.name),
    );

    if (adScreenNames.size > 0) {
      const screenLevelMismatches = [];
      const realMismatches = [];

      for (const mm of analysis.accessibilityMismatch) {
        const isOnlyAdMissing =
          mm.mismatches.length === 1 &&
          mm.mismatches[0].field === "audioDescription" &&
          mm.mismatches[0].type === "missing-in-ours";

        const screenHasAd = mm.ours.screen && adScreenNames.has(mm.ours.screen);

        if (isOnlyAdMissing && screenHasAd) {
          screenLevelMismatches.push(mm);
        } else {
          realMismatches.push(mm);
        }
      }

      if (screenLevelMismatches.length > 0) {
        analysis.screenLevelAdCount = screenLevelMismatches.length;
        analysis.accessibilityMismatch = realMismatches;
      }
    }

    // Separate out mismatches where we only have extra data that UKCA lacks.
    // These aren't gaps in our data — we're more detailed than UKCA.
    const extraOnly = [];
    const actionable = [];

    for (const mm of analysis.accessibilityMismatch) {
      const hasMissing = mm.mismatches.some(
        (mis) => mis.type === "missing-in-ours",
      );
      if (hasMissing) {
        actionable.push(mm);
      } else {
        extraOnly.push(mm);
      }
    }

    if (extraOnly.length > 0) {
      analysis.extraOnlyCount = extraOnly.length;
      analysis.accessibilityMismatch = actionable;
    }

    venueAnalyses[m.venueId] = analysis;
  }

  // Step 3: Report
  console.log("");
  const report = formatReport(venueMatchResult, venueAnalyses, ukcaData);
  console.log(report);

  writeJsonLog(venueMatchResult, venueAnalyses, ukcaData);

  // Exit code based on findings
  const hasCritical =
    venueMatchResult.unmatchedUkca.filter(
      (u) => u.theater.showtimesDates && u.theater.showtimesDates.length > 0,
    ).length > 0;

  const hasMismatches = Object.values(venueAnalyses).some(
    (a) => a.accessibilityMismatch.length > 0,
  );

  if (hasCritical || hasMismatches) {
    process.exitCode = 1;
  }
}

main();
