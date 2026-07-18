const fs = require("fs");
const path = require("path");
const { remove: removeDiacritics } = require("diacritics");
const { toZonedTime, fromZonedTime } = require("date-fns-tz");
const { getAttributesFor } = require("./utils");
const normalizeTitle = require("scripts/common/normalize-title");
const MANUAL_EXCLUSIONS = require("./accessibility-exclusions");
const { isKnownMismatch } = require("./common/known-mismatches");
const { writeBadge } = require("./common/badge");

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
  "Showtime.Accessibility.AudioDescription": ["audioDescription"],
  "Showtime.Accessibility.AutismFriendly": ["relaxed"],
  "Showtime.Accessibility.DementiaFriendly": ["relaxed"],
  "Showtime.Accessibility.Subtitled": ["subtitled"],
  "Showtime.Accessibility.ClosedCaption": ["hardOfHearing"],
  "Showtime.Accessibility.OpenCaption": ["subtitled", "hardOfHearing"],
};

function ukcaTagsToAccessibility(tags) {
  const result = {};
  const sourceTag = {};
  const unknownTags = [];

  for (const tag of tags) {
    if (!tag.startsWith("Showtime.Accessibility.")) continue;
    if (tag === "Showtime.Accessibility.Accessible") continue;

    const fields = UKCA_TAG_MAP[tag];
    if (fields) {
      const shortTag = tag.replace("Showtime.Accessibility.", "");
      for (const field of fields) {
        result[field] = true;
        sourceTag[field] = shortTag;
      }
    } else {
      unknownTags.push(tag);
    }
  }

  return { accessibility: result, sourceTag, unknownTags };
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
  return removeDiacritics(name)
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
        // UKCA startsAt is London wall-clock time (e.g. "2026-07-04 12:30:00"),
        // not UTC. Interpret it in Europe/London so the epoch matches ours —
        // appending "Z" would treat it as UTC and be an hour off during BST.
        startsAtMs: fromZonedTime(
          st.startsAt.replace(" ", "T"),
          "Europe/London",
        ).getTime(),
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

// Extract a performance ID from a booking URL using common query parameters.
// Returns null if no recognisable ID parameter is found.
const PERF_ID_PARAMS = ["id", "perfcode", "showtimeid", "eid", "eventinstanceid"];

function extractPerfId(url) {
  try {
    const u = new URL(url);
    for (const key of PERF_ID_PARAMS) {
      for (const [k, v] of u.searchParams) {
        if (k.toLowerCase() === key && v) return v;
      }
    }
    // Fallback: some sites carry the performance ID as a path segment rather
    // than a query param. Usually it's the trailing segment (e.g. ActOne's
    // /checkout/showing/<slug>/452296, matching UKCA's .../452296), but some
    // sites append an action segment after it — Picturehouses booking links are
    // /order/showtimes/016-19007/seats, where 016-19007 (cinemaId-sessionId) is
    // the stable ID. Scan the last two segments and take the first that looks
    // like a numeric performance ID (optionally a single hyphenated pair).
    const segments = u.pathname.replace(/\/$/, "").split("/");
    for (const seg of segments.slice(-2).reverse()) {
      if (/^\d+(-\d+)?$/.test(seg)) return seg;
    }
  } catch {
    // not a valid URL
  }
  return null;
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

  // Build performance ID lookup for our performances
  const ourPerfIds = ourFlat.map((o) =>
    o.bookingUrl ? extractPerfId(o.bookingUrl) : null,
  );

  // Build fully-normalized title lookup for our performances (used by the
  // normalized-title stage below).
  const ourNormTitles = ourFlat.map((o) =>
    o.showingTitle ? normalizeTitle(o.showingTitle) : "",
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

  // Secondary: match by performance ID extracted from URL
  // Handles cases where URLs differ in structure but share the same ID param
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    if (usedUkcaIdx.has(ui)) continue;
    const ukca = ukcaFlat[ui];

    const ukcaPerfIds = ukca.bookingUrls.map(extractPerfId).filter(Boolean);
    if (ukcaPerfIds.length === 0) continue;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      if (!ourPerfIds[oi]) continue;

      if (ukcaPerfIds.includes(ourPerfIds[oi])) {
        usedUkcaIdx.add(ui);
        usedOurIdx.add(oi);
        matchedPerfs.push({
          ukca,
          ours: ourFlat[oi],
          matchMethod: "perfId",
        });
        break;
      }
    }
  }

  // Tertiary: match by title + time within tolerance
  // Title similarity is required (>= 0.3) — time alone cannot identify a
  // performance since multi-screen cinemas have different films at the same time.
  // If both URLs have a recognisable performance ID that doesn't match, skip —
  // they are definitively different performances even if title and time align.
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    if (usedUkcaIdx.has(ui)) continue;
    const ukca = ukcaFlat[ui];

    const ukcaPerfIds = ukca.bookingUrls.map(extractPerfId).filter(Boolean);

    let bestOurIdx = -1;
    let bestTitleSim = 0;
    let bestDelta = Infinity;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;

      // If both sides have a perf ID and they don't match, skip
      if (
        ukcaPerfIds.length > 0 &&
        ourPerfIds[oi] &&
        !ukcaPerfIds.includes(ourPerfIds[oi])
      ) {
        continue;
      }

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

  // Quaternary: match by fully-normalized title + time within tolerance.
  // The tertiary stage's word-set similarity can dip below its 0.3 threshold
  // when the same film carries different qualifiers on each side (e.g. UKCA's
  // "Amores Perros (Love's A Bitch)" vs our "Amores Perros: 4K Restoration",
  // which share only two words). Running the pipeline's own normalizeTitle over
  // both sides collapses those qualifiers to a canonical title, so a genuine
  // match survives. Same guards as the tertiary stage: perf IDs must not
  // conflict, and time must be within tolerance; ambiguous ties broken on time.
  for (let ui = 0; ui < ukcaFlat.length; ui++) {
    if (usedUkcaIdx.has(ui)) continue;
    const ukca = ukcaFlat[ui];

    const ukcaNormTitle = normalizeTitle(ukca.movieTitle);
    if (!ukcaNormTitle) continue;

    const ukcaPerfIds = ukca.bookingUrls.map(extractPerfId).filter(Boolean);

    let bestOurIdx = -1;
    let bestDelta = Infinity;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      if (!ourNormTitles[oi] || ourNormTitles[oi] !== ukcaNormTitle) continue;

      // If both sides have a perf ID and they don't match, skip
      if (
        ukcaPerfIds.length > 0 &&
        ourPerfIds[oi] &&
        !ukcaPerfIds.includes(ourPerfIds[oi])
      ) {
        continue;
      }

      const delta = Math.abs(ukca.startsAtMs - ourFlat[oi].time);
      if (delta > TIME_TOLERANCE_MS) continue;

      if (delta < bestDelta) {
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
        matchMethod: "normalizedTitle",
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
  const {
    accessibility: ukcaAccess,
    sourceTag,
    unknownTags,
  } = ukcaTagsToAccessibility(ukcaTags);

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
      mismatches.push({
        field,
        type: "missing-in-ours",
        ukcaTag: sourceTag[field],
      });
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

  // UKCA-only accessible performances (ones we don't have at all). Sports/live
  // events and private hires we deliberately strip out are expected gaps, not
  // real ones — separate them into an informational count.
  const ukcaOnlyAccessibleAll = ukcaOnly.filter((u) =>
    hasAccessibilityTags(u.tags),
  );
  const ukcaOnlyAccessible = ukcaOnlyAccessibleAll.filter(
    (u) => !isKnownMismatch(u.movieTitle),
  );
  const knownMismatchCount =
    ukcaOnlyAccessibleAll.length - ukcaOnlyAccessible.length;

  return {
    totalUkca: ukcaFlat.length,
    totalOurs: ourFlat.length,
    matchedCount: matchedPerfs.length,
    ukcaOnlyCount: ukcaOnly.length,
    ourOnlyCount: ourOnly.length,
    accessibilityConsistent: accessibilityConsistent.length,
    accessibilityMismatch,
    ukcaOnlyAccessible,
    knownMismatchCount,
    unknownTags: [...allUnknownTags],
  };
}

// ---------------------------------------------------------------------------
// Cineworld listing verification
// ---------------------------------------------------------------------------

// Check if a Cineworld performance still exists via their API.
// Returns true if valid, false if the listing has been removed.
async function verifyCineworldListing(url) {
  try {
    const u = new URL(url);
    const site = u.searchParams.get("site") || u.searchParams.get("sitecode");
    const sessionId = u.searchParams.get("id");
    if (!site || !sessionId) return true; // can't verify, assume valid

    const apiUrl = `https://experience.cineworld.co.uk/api/OrderMedia?theatreCode=${site}&sessionId=${sessionId}`;
    const res = await fetch(apiUrl);
    if (!res.ok) return false;

    const data = await res.json();
    // A valid listing returns session data; a removed one returns an error or empty
    return !!(data && !data.error);
  } catch {
    return true; // on network error, assume valid
  }
}

// Filter UKCA-only accessible performances for Cineworld venues, removing
// listings that no longer exist on Cineworld's site (stale UKCA data).
async function filterStaleCineworldListings(ukcaOnlyAccessible, venueId) {
  if (!venueId.startsWith("cineworld.co.uk")) return ukcaOnlyAccessible;
  if (ukcaOnlyAccessible.length === 0) return ukcaOnlyAccessible;

  const results = await Promise.all(
    ukcaOnlyAccessible.map(async (u) => {
      const url = u.bookingUrls[0];
      if (!url || !url.includes("cineworld.co.uk")) return { u, valid: true };
      const valid = await verifyCineworldListing(url);
      return { u, valid };
    }),
  );

  const valid = results.filter((r) => r.valid).map((r) => r.u);
  const stale = results.filter((r) => !r.valid).length;

  return { filtered: valid, staleCount: stale };
}

// Verify Cineworld AD mismatches against Cineworld's own showtimes API.
// Groups mismatches by date and fetches each date's event listing once, then
// checks whether the performance actually has the "audio-described" attribute.
// Returns { verified: mismatches confirmed by CW API, staleAd: count removed }.
// If there are more than `cap` mismatches, skips verification entirely and
// returns null to signal that the caller should show an error instead.
const CW_AD_VERIFY_CAP = 25;

async function verifyCineworldAdMismatches(mismatches, venueId) {
  if (!venueId.startsWith("cineworld.co.uk")) return null;

  // Find mismatches that include "missing audioDescription"
  const withAdMissing = mismatches.filter((mm) =>
    mm.mismatches.some(
      (mis) =>
        mis.field === "audioDescription" && mis.type === "missing-in-ours",
    ),
  );
  if (withAdMissing.length === 0) return null;
  if (withAdMissing.length > CW_AD_VERIFY_CAP)
    return { tooMany: withAdMissing.length };

  // Extract site code from any booking URL
  const sampleUrl =
    withAdMissing[0].ours.bookingUrl || withAdMissing[0].ukca.bookingUrls[0];
  let siteCode;
  try {
    const u = new URL(sampleUrl);
    siteCode = u.searchParams.get("site") || u.searchParams.get("sitecode");
  } catch {
    return null;
  }
  if (!siteCode) return null;

  // Group by business date so we fetch each date only once
  const byDate = new Map();
  for (const mm of withAdMissing) {
    const time = mm.ours.time || mm.ukca.startsAtMs;
    const d = new Date(time).toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(mm);
  }

  // Fetch event listings per date
  const cwEvents = new Map(); // id -> attributeIds
  for (const date of byDate.keys()) {
    try {
      const url = `https://www.cineworld.co.uk/uk/data-api-service/v1/quickbook/10108/film-events/in-cinema/${siteCode}/at-date/${date}?attr=&lang=en_GB`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const e of data?.body?.events || []) {
        cwEvents.set(e.id, e.attributeIds || []);
      }
    } catch {
      // On error, skip this date — mismatches will be kept as-is
    }
  }

  if (cwEvents.size === 0) {
    return { apiBlocked: true, count: withAdMissing.length };
  }

  // Check each mismatch against the fetched data
  let staleAd = 0;
  const verified = [];
  const unaffected = mismatches.filter((mm) => !withAdMissing.includes(mm));

  for (const mm of withAdMissing) {
    const perfId = extractPerfId(mm.ours.bookingUrl || mm.ukca.bookingUrls[0]);
    if (perfId && cwEvents.has(perfId)) {
      const attrs = cwEvents.get(perfId);
      if (attrs.includes("audio-described")) {
        // Cineworld confirms AD — this is a genuine gap in our data
        verified.push(mm);
      } else {
        // Cineworld doesn't have AD — UKCA is wrong; strip the AD mismatch
        staleAd++;
        const remaining = mm.mismatches.filter(
          (mis) =>
            !(
              mis.field === "audioDescription" && mis.type === "missing-in-ours"
            ),
        );
        if (remaining.length > 0) {
          verified.push({ ...mm, mismatches: remaining });
        }
      }
    } else {
      // Couldn't verify — keep as mismatch
      verified.push(mm);
    }
  }

  return {
    mismatches: [...unaffected, ...verified],
    staleAd,
  };
}

// ---------------------------------------------------------------------------
// Manual exclusions
// ---------------------------------------------------------------------------

// Does this mismatch belong to a manually-reviewed exclusion for this venue?
// Matches on performance ID extracted from either side's booking URL.
function mismatchMatchesExclusion(venueId, mm, excl) {
  if (excl.venueId !== venueId) return false;

  const perfIds = [
    mm.ours.bookingUrl ? extractPerfId(mm.ours.bookingUrl) : null,
    ...mm.ukca.bookingUrls.map(extractPerfId),
  ].filter(Boolean);

  return excl.perfIds.some((id) => perfIds.includes(id));
}

// Strip mismatches covered by MANUAL_EXCLUSIONS out of the actionable set and
// roll them into an informational count. Only "missing-in-ours" fields listed
// in the exclusion (or all of them, if `fields` is omitted) are excused; any
// other mismatch on the same performance is preserved so it stays actionable.
function applyManualExclusions(analysis, venueId) {
  const venueExclusions = MANUAL_EXCLUSIONS.filter(
    (e) => e.venueId === venueId,
  );
  if (venueExclusions.length === 0) return;

  const remaining = [];
  let excludedCount = 0;

  for (const mm of analysis.accessibilityMismatch) {
    const excl = venueExclusions.find((e) =>
      mismatchMatchesExclusion(venueId, mm, e),
    );

    if (!excl) {
      remaining.push(mm);
      continue;
    }

    const kept = mm.mismatches.filter((mis) => {
      if (mis.type !== "missing-in-ours") return true; // only excuse gaps
      if (!excl.fields) return false; // no fields listed → excuse all gaps
      return !excl.fields.includes(mis.field);
    });

    if (kept.length === mm.mismatches.length) {
      // Exclusion matched the performance but none of its fields — leave it.
      remaining.push(mm);
      continue;
    }

    excludedCount++;
    if (kept.length > 0) remaining.push({ ...mm, mismatches: kept });
  }

  if (excludedCount > 0) {
    analysis.manualExclusionCount =
      (analysis.manualExclusionCount || 0) + excludedCount;
    analysis.accessibilityMismatch = remaining;
  }
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

  // Unmatched UKCA theaters. Split by whether they have upcoming showtimes:
  // entries with none are almost always stale/closed venues UKCA still lists
  // (their own data shows them inactive), so they're informational. Entries WITH
  // live showtimes are the genuinely actionable case — a new venue we should
  // cover, or a matching failure — and shouldn't be buried among closed cinemas.
  const hasUpcoming = ({ theater }) =>
    theater.showtimesDates && theater.showtimesDates.length > 0;
  const unmatchedLive = unmatchedUkca.filter(hasUpcoming);
  const unmatchedClosed = unmatchedUkca.filter((u) => !hasUpcoming(u));

  const renderUnmatchedTheater = ({ theater, nearest }, nameColor) => {
    const hasDates =
      theater.showtimesDates && theater.showtimesDates.length > 0;
    const dateNote = hasDates
      ? `${theater.showtimesDates.length} showtime dates`
      : "no upcoming showtimes";
    lines.push(`  ${nameColor}${theater.name}${c.reset} (${dateNote})`);
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
  };

  // Actionable: unmatched but with live showtimes.
  if (unmatchedLive.length > 0) {
    lines.push(
      `${c.bold}${c.red}Unmatched UKCA Theaters with Live Showtimes (${unmatchedLive.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}These are active UKCA theaters we couldn't match to any of our venues.${c.reset}`,
    );
    lines.push(
      `${c.dim}They may represent new venue opportunities or matching failures.${c.reset}`,
    );
    lines.push("");

    for (const entry of unmatchedLive) {
      renderUnmatchedTheater(entry, c.yellow);
    }
  }

  // Informational: unmatched with no showtimes — almost certainly closed/stale.
  if (unmatchedClosed.length > 0) {
    lines.push(
      `${c.bold}${c.dim}Unmatched UKCA Theaters — Likely Closed (${unmatchedClosed.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}No upcoming showtimes in UKCA's own data — likely closed venues still listed (stale source data). Informational only.${c.reset}`,
    );
    lines.push("");

    for (const entry of unmatchedClosed) {
      renderUnmatchedTheater(entry, c.dim);
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
      if (analysis.vueBabyAutismCount) {
        infoParts.push(
          `${analysis.vueBabyAutismCount} Vue morning babyFriendly vs AutismFriendly (UKCA wrong)`,
        );
      }
      if (analysis.cineworldStaleAdCount) {
        infoParts.push(
          `${analysis.cineworldStaleAdCount} Cineworld AD mismatches verified as UKCA stale data`,
        );
      }
      if (analysis.cineworldStaleCount) {
        infoParts.push(
          `${analysis.cineworldStaleCount} stale Cineworld listings removed`,
        );
      }
      if (analysis.manualExclusionCount) {
        infoParts.push(
          `${analysis.manualExclusionCount} manually excluded (UKCA reviewed as incorrect)`,
        );
      }
      if (analysis.knownMismatchCount) {
        infoParts.push(
          `${analysis.knownMismatchCount} sports/live events we strip out (expected gaps)`,
        );
      }
      if (analysis.cineworldAdApiBlocked) {
        infoParts.push(
          `${c.yellow}${analysis.cineworldAdApiBlocked} Cineworld AD mismatches could not be verified (API blocked)${c.reset}`,
        );
      }
      if (analysis.cineworldAdTooMany) {
        infoParts.push(
          `${c.red}${analysis.cineworldAdTooMany} Cineworld AD mismatches exceed verification cap (${CW_AD_VERIFY_CAP}) — not verified${c.reset}`,
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
                `        ${c.red}Missing:${c.reset} ${mis.ukcaTag && mis.ukcaTag !== mis.field ? `${mis.ukcaTag} \u2192 ` : ""}${mis.field} (UKCA has it, we don't)`,
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
      if (analysis.vueBabyAutismCount)
        notes.push(`${analysis.vueBabyAutismCount} Vue baby/autism`);
      if (analysis.cineworldStaleAdCount)
        notes.push(`${analysis.cineworldStaleAdCount} stale CW AD`);
      if (analysis.cineworldAdApiBlocked)
        notes.push(`${analysis.cineworldAdApiBlocked} CW AD unverified`);
      if (analysis.cineworldStaleCount)
        notes.push(`${analysis.cineworldStaleCount} stale CW listings`);
      if (analysis.manualExclusionCount)
        notes.push(`${analysis.manualExclusionCount} manual exclusions`);
      if (analysis.knownMismatchCount)
        notes.push(`${analysis.knownMismatchCount} sports/live events`);
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

async function main() {
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

  // Fast-fail: zero matches means something is fundamentally wrong (empty or
  // wrong transformed-data dir, geo lookups all failing, etc.) rather than a
  // real accessibility finding. Bail loudly instead of "succeeding" at nothing.
  if (venueMatchResult.matched.length === 0) {
    console.error(
      `\n${c.bold}${c.red}No venues matched.${c.reset} ` +
        `Loaded ${Object.keys(transformedVenues).length} venue file(s) from "${transformedDir}" ` +
        `against ${ukcaData.theaters.length} UKCA theater(s).\n` +
        `This almost always means the transformed-data directory is empty or wrong ` +
        `(e.g. pass "transformed-data/current", not "transformed-data").`,
    );
    process.exit(1);
  }

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

    // Cineworld AD verification: UKCA sometimes retains stale AudioDescription
    // tags after Cineworld changes schedules. Verify remaining AD-only mismatches
    // against Cineworld's own showtimes API. Capped at 25 per venue to avoid
    // excessive API calls; if over the cap, skip verification and flag the issue.
    if (m.venueId.startsWith("cineworld.co.uk")) {
      const adResult = await verifyCineworldAdMismatches(
        analysis.accessibilityMismatch,
        m.venueId,
      );
      if (adResult) {
        if (adResult.tooMany) {
          analysis.cineworldAdTooMany = adResult.tooMany;
        } else if (adResult.apiBlocked) {
          analysis.cineworldAdApiBlocked = adResult.count;
        } else {
          if (adResult.staleAd > 0) {
            analysis.cineworldStaleAdCount =
              (analysis.cineworldStaleAdCount || 0) + adResult.staleAd;
            analysis.accessibilityMismatch = adResult.mismatches;
          }
        }
      }
    }

    // Vue morning screenings: UKCA tags as AutismFriendly, we tag as babyFriendly.
    // These are the same morning screenings — Vue calls them "Mighty Mornings" (baby
    // friendly), UKCA categorises them as autism friendly. Roll up as info.
    // The Mighty Mornings slot is nominally 10am but individual screenings drift
    // (e.g. 09:45, 09:55), so allow a ±15 min window around 10:00 rather than an
    // exact hour match.
    // NOTE: this runs before the extra-only filter so that leftover babyFriendly-only
    // entries (after stripping relaxed) are caught by the extra-only pass below.
    if (m.venueId.startsWith("myvue.com")) {
      const vueBabyAutism = [];
      const vueOther = [];

      for (const mm of analysis.accessibilityMismatch) {
        // Use London-local time so the morning carve-out holds year-round: in BST
        // a 10am screening is stored as 09:00 UTC, so getUTCHours() would miss it.
        const local = toZonedTime(mm.ours.time, "Europe/London");
        const minutesFromMidnight = local.getHours() * 60 + local.getMinutes();
        const isMorningSlot = Math.abs(minutesFromMidnight - 600) <= 15; // 09:45–10:15
        const hasMissingRelaxed = mm.mismatches.some(
          (mis) =>
            mis.field === "relaxed" &&
            mis.type === "missing-in-ours" &&
            mis.ukcaTag === "AutismFriendly",
        );

        if (isMorningSlot && hasMissingRelaxed) {
          // Remove the relaxed mismatch; keep any other mismatches
          const remaining = mm.mismatches.filter(
            (mis) =>
              !(
                mis.field === "relaxed" &&
                mis.type === "missing-in-ours" &&
                mis.ukcaTag === "AutismFriendly"
              ),
          );
          vueBabyAutism.push(mm);
          if (remaining.length > 0) {
            vueOther.push({ ...mm, mismatches: remaining });
          }
        } else {
          vueOther.push(mm);
        }
      }

      if (vueBabyAutism.length > 0) {
        analysis.vueBabyAutismCount = vueBabyAutism.length;
        analysis.accessibilityMismatch = vueOther;
      }
    }

    // Separate out mismatches where we only have extra data that UKCA lacks.
    // These aren't gaps in our data — we're more detailed than UKCA.
    // Runs last so it catches leftovers from earlier carve-outs (e.g. Vue
    // babyFriendly-only after stripping relaxed).
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
      analysis.extraOnlyCount =
        (analysis.extraOnlyCount || 0) + extraOnly.length;
      analysis.accessibilityMismatch = actionable;
    }

    // Final carve-out: manually-reviewed cases where we've concluded UKCA is
    // wrong. Runs last so it only ever acts on genuinely-actionable leftovers.
    applyManualExclusions(analysis, m.venueId);

    venueAnalyses[m.venueId] = analysis;
  }

  // Verify Cineworld UKCA-only accessible performances against their API.
  // Stale listings (removed from Cineworld but still in UKCA data) are filtered out.
  const cineworldVenues = venueMatchResult.matched.filter((m) =>
    m.venueId.startsWith("cineworld.co.uk"),
  );
  if (cineworldVenues.length > 0) {
    const totalToCheck = cineworldVenues.reduce(
      (n, m) => n + (venueAnalyses[m.venueId]?.ukcaOnlyAccessible?.length || 0),
      0,
    );
    if (totalToCheck > 0) {
      console.log(
        `Verifying ${totalToCheck} Cineworld UKCA-only listings against API...`,
      );
      for (const m of cineworldVenues) {
        const analysis = venueAnalyses[m.venueId];
        if (!analysis || analysis.ukcaOnlyAccessible.length === 0) continue;

        const result = await filterStaleCineworldListings(
          analysis.ukcaOnlyAccessible,
          m.venueId,
        );
        if (result.staleCount > 0) {
          analysis.cineworldStaleCount =
            (analysis.cineworldStaleCount || 0) + result.staleCount;
          analysis.ukcaOnlyAccessible = result.filtered;
        }
      }
    }
  }

  // Step 3: Report
  console.log("");
  const report = formatReport(venueMatchResult, venueAnalyses, ukcaData);
  console.log(report);

  writeJsonLog(venueMatchResult, venueAnalyses, ukcaData);

  // Findings (shared by the badge and the exit code so they can never disagree).
  // Critical: a UKCA theatre we failed to match that still has showtimes — a
  // venue we appear to be missing entirely.
  const criticalCount = venueMatchResult.unmatchedUkca.filter(
    (u) => u.theater.showtimesDates && u.theater.showtimesDates.length > 0,
  ).length;

  const mismatchCounts = Object.values(venueAnalyses).map(
    (a) => a.accessibilityMismatch.length,
  );
  const totalMismatches = mismatchCounts.reduce((n, c) => n + c, 0);
  const venuesAffected = mismatchCounts.filter((c) => c > 0).length;
  const maxPerVenue = mismatchCounts.reduce((m, c) => Math.max(m, c), 0);

  writeBadge("compare-accessible-screenings.json", {
    label: "Compare Accessible Screenings",
    total: totalMismatches,
    venuesAffected,
    maxPerVenue,
    critical: criticalCount,
  });

  // Exit code based on findings
  if (criticalCount > 0 || totalMismatches > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
