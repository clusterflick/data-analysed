const fs = require("fs");
const path = require("path");
const { remove: removeDiacritics } = require("diacritics");
const { getAttributesFor } = require("./utils");
const {
  verifyCineworldListing,
  verifyNickelListing,
  verifyVueListing,
  verifyCurzonListing,
  verifyOdeonListing,
  verifyEverymanListing,
  verifyPicturehousesListing,
  verifyPrinceCharlesListing,
  verifyForestCinemaListing,
  verifyCastleCinemaListing,
} = require("./verify-listings");

const CW_VERIFY_CAP = 25;
const NICKEL_VERIFY_CAP = 25;
const VUE_VERIFY_CAP = 25;
const CURZON_VERIFY_CAP = 25;
const ODEON_VERIFY_CAP = 25;
const EVERYMAN_VERIFY_CAP = 25;
const PICTUREHOUSES_VERIFY_CAP = 25;
const PCC_VERIFY_CAP = 25;
const FOREST_VERIFY_CAP = 25;
const CASTLE_VERIFY_CAP = 25;

const TIME_TOLERANCE_MS = 15 * 60 * 1000; // 15 minutes

// Venues where CinemaGuide mis-parses BST datetimes: it trusts a machine-
// readable datetime attribute that the venue writes as local (BST) time but
// labels as UTC, so CG's times run 1 hour ahead of ours during British Summer
// Time. Our pipeline stores the correct UTC time. For these venues we shift
// CG's time back by 1 hour before comparing (only for timestamps that fall in
// the BST window — outside it CG's times are already correct).
const BST_OFFSET_VENUES = new Set([
  "barbican.org.uk",
  "forestcinema.co.uk",
  "arthousecrouchend.co.uk",
  "olympiccinema.com",
  "peckhamplex.london",
  "thegardencinema.co.uk",
  "electriccinema.co.uk-white-city",
  "electriccinema.co.uk-portobello",
]);

const BST_OFFSET_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Known CG-only mismatches — screenings we deliberately don't include
// ---------------------------------------------------------------------------

// Titles matching these patterns are sports/live events or private hires we
// filter out of our data. When they appear as CG-only they're expected, not a
// real gap.
const KNOWN_MISMATCH_PATTERNS = [
  /\s+Cup Screening$/i,
  /\s+League Screening$/i,
  /Union Jack Classic/i,
  /Super Bowl/i,
  /Six Nations/i,
  /AFCON\s+/i,
  /GRAND PRIX:/i,
  /^\w+\s+FANPARK:/i,
  /\bPrivate Hire\b/i,
];

function isKnownMismatch(title) {
  return KNOWN_MISMATCH_PATTERNS.some((re) => re.test(title));
}

// Venue-specific CG data quality artifacts — parser failures that produce
// screenings we should ignore rather than treat as real gaps.
function isCgDataArtifact(screening, venueId) {
  // Garden Cinema: when CG's parser can't read the date it defaults to Jan 1st
  // while keeping the time. These are never real screenings.
  if (venueId === "thegardencinema.co.uk") {
    const d = new Date(screening.timeMs);
    if (d.getUTCMonth() === 0 && d.getUTCDate() === 1) return true;
  }
  return false;
}

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
// Name similarity helpers
// ---------------------------------------------------------------------------

const VENUE_NOISE_WORDS = new Set(["cinema", "london", "the"]);

function normalizeVenueName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[''\u2019]s\b/g, "s")
      // Normalise "picturehouse" (one word) to "picture house" (two words) so that
      // "Hackney Picturehouse" and "Picture House Hackney" share the same tokens.
      .replace(/\bpicturehouse\b/g, "picture house")
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !VENUE_NOISE_WORDS.has(w))
      .join(" ")
  );
}

// Returns true if every word in `subset` appears in `superset` (word-level containment).
function wordsAllIn(subset, superset) {
  const superWords = new Set(superset.split(" ").filter(Boolean));
  return subset
    .split(" ")
    .filter(Boolean)
    .every((w) => superWords.has(w));
}

function venueNameSimilarity(a, b) {
  const na = normalizeVenueName(a);
  const nb = normalizeVenueName(b);
  if (na === nb) return 1;
  // Use word-level containment (not substring) to avoid single-letter false matches
  // e.g. "w" (from "W London") matching the letter "w" inside "west"
  if (wordsAllIn(nb, na) || wordsAllIn(na, nb)) return 0.8;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

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
// DST helpers
// ---------------------------------------------------------------------------

// Returns the last Sunday of a given month (0-indexed) as a UTC Date.
function lastSundayOf(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // rewind to Sunday
  return d;
}

// Returns true if the timestamp falls within UK British Summer Time.
// BST runs from the last Sunday of March at 01:00 UTC to the last Sunday of
// October at 01:00 UTC.
function isDuringBST(ms) {
  const year = new Date(ms).getUTCFullYear();
  const bstStart = lastSundayOf(year, 2); // March (0-indexed)
  bstStart.setUTCHours(1);
  const bstEnd = lastSundayOf(year, 9); // October
  bstEnd.setUTCHours(1);
  return ms >= bstStart.getTime() && ms < bstEnd.getTime();
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  try {
    // Normalise double slashes in path (CG sometimes has e.g. //whats-on/...)
    let cleaned = url.replace(/([^:])\/\/+/g, "$1/");
    // Strip malformed path-level query params: CG Everyman URLs sometimes
    // append &key=value directly to the path segment with no leading '?'
    // e.g. /launch/ticketing/{uuid}&x-wwm-soldout=1
    cleaned = cleaned.replace(/^([^?]*)&[^?]*/, "$1");
    const u = new URL(cleaned);
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

const PERF_ID_PARAMS = ["id", "perfcode", "showtimeid", "eid"];

function extractPerfId(url) {
  try {
    const u = new URL(url);
    for (const key of PERF_ID_PARAMS) {
      for (const [k, v] of u.searchParams) {
        if (k.toLowerCase() === key && v) return v;
      }
    }
  } catch {
    // not a valid URL
  }
  return null;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadCinemaguideData(filePath) {
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

function getVenueName(venueId) {
  try {
    const attrs = getAttributesFor(venueId);
    if (attrs && attrs.name) return attrs.name;
  } catch {
    // not found
  }
  return venueId;
}

// ---------------------------------------------------------------------------
// Build per-venue index from cinemaguide data
// ---------------------------------------------------------------------------

function buildCinemaguideByVenue(cgData) {
  const byVenue = new Map(); // venue_name -> [{filmSlug, filmTitle, timeMs, time, link}]
  const filmMeta = cgData.data.film_meta_data_map;

  for (const film of cgData.data.all_screenings_on_all_dates.film_data) {
    const filmTitle = filmMeta[film.title]?.display_film_title || film.title;

    for (const dateGroup of film.screenings_data) {
      for (const s of dateGroup.screenings) {
        if (!byVenue.has(s.venue_name)) byVenue.set(s.venue_name, []);
        byVenue.get(s.venue_name).push({
          filmSlug: film.title,
          filmTitle,
          timeMs: new Date(s.time).getTime(),
          time: s.time,
          link: s.link,
        });
      }
    }
  }

  // Deduplicate: CG sometimes lists the same TicketSource event under both a
  // programme title and an individual film title, producing duplicate entries
  // with identical link + timeMs. Keep only the first occurrence per venue.
  for (const [venueName, screenings] of byVenue) {
    const seen = new Set();
    byVenue.set(
      venueName,
      screenings.filter((s) => {
        const key = `${s.link}|${s.timeMs}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }

  return byVenue;
}

// ---------------------------------------------------------------------------
// Venue matching — URL overlap primary, name similarity fallback
// ---------------------------------------------------------------------------

// Extract a venue-level key from a booking URL, stripping the performance-
// specific part. Returns null for chains where exact URL matching already works.
//
// Picturehouse: /movie-details/{code}/... and /showtimes/{code}-... → picturehouses/{code}
// Vue:          //book-tickets/summary/{id}/... (double-slash in CG data) → myvue/{id}
function extractVenueKey(url) {
  try {
    // Normalise double slashes in path (CG Vue URLs have //book-tickets)
    const cleaned = url.replace(/([^:])\/\/+/g, "$1/");
    const u = new URL(cleaned);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname;

    if (host === "picturehouses.com" || host === "web.picturehouses.com") {
      const m = path.match(/\/(?:movie-details|showtimes)\/(\d+)/);
      if (m) return `picturehouses/${m[1]}`;
    }
    if (host === "myvue.com") {
      const m = path.match(/\/book-tickets\/summary\/(\d+)/);
      if (m) return `myvue/${m[1]}`;
    }
  } catch {
    // not a valid URL
  }
  return null;
}

// Build URL sets + venue keys for each CG venue.
function buildCgUrlSets(cgByVenue) {
  const sets = new Map(); // venueName -> { urls: Set, venueKeys: Set }
  for (const [venueName, screenings] of cgByVenue) {
    const urls = new Set();
    const venueKeys = new Set();
    for (const s of screenings) {
      if (!s.link) continue;
      urls.add(normalizeUrl(s.link));
      const vk = extractVenueKey(s.link);
      if (vk) venueKeys.add(vk);
    }
    sets.set(venueName, { urls, venueKeys });
  }
  return sets;
}

// Build URL sets + venue keys for each of our venues.
function buildOurUrlSets(transformedVenues) {
  const sets = {}; // venueId -> { urls: Set, venueKeys: Set }
  for (const [venueId, showings] of Object.entries(transformedVenues)) {
    const urls = new Set();
    const venueKeys = new Set();
    for (const showing of showings || []) {
      for (const perf of showing.performances || []) {
        if (!perf.bookingUrl) continue;
        urls.add(normalizeUrl(perf.bookingUrl));
        const vk = extractVenueKey(perf.bookingUrl);
        if (vk) venueKeys.add(vk);
      }
    }
    sets[venueId] = { urls, venueKeys };
  }
  return sets;
}

// Overlap score (0–1): try venue keys first, fall back to exact URLs.
// Venue keys work for Picturehouse and Vue where URL formats differ between CG
// and our data. Exact URL overlap works for Odeon, Everyman, Curzon, etc.
function urlOverlapScore(cgSets, ourSets) {
  const { urls: cgUrls, venueKeys: cgKeys } = cgSets;
  const { urls: ourUrls, venueKeys: ourKeys } = ourSets;

  if (cgKeys.size > 0 && ourKeys.size > 0) {
    let keyOverlap = 0;
    for (const k of cgKeys) {
      if (ourKeys.has(k)) keyOverlap++;
    }
    if (keyOverlap > 0) {
      return keyOverlap / Math.min(cgKeys.size, ourKeys.size);
    }
  }

  if (cgUrls.size === 0 || ourUrls.size === 0) return 0;
  let urlOverlap = 0;
  for (const url of cgUrls) {
    if (ourUrls.has(url)) urlOverlap++;
  }
  return urlOverlap / Math.min(cgUrls.size, ourUrls.size);
}

const NAME_MATCH_THRESHOLD = 0.8;

// Hard-coded aliases for venues where names diverge too much for automated
// matching (e.g. CG uses neighbourhood name, we use street name).
const CG_VENUE_ALIASES = {
  "Electric Cinema Notting Hill": "electriccinema.co.uk-portobello",
};

function matchVenues(cgByVenue, transformedVenues) {
  const cgVenueNames = [...cgByVenue.keys()];
  const ourVenueIds = Object.keys(transformedVenues);

  const cgUrlSets = buildCgUrlSets(cgByVenue);
  const ourUrlSets = buildOurUrlSets(transformedVenues);

  // Apply hard-coded aliases first, before automated scoring.
  const matched = [];
  const matchedCgNames = new Set();
  const usedOurIds = new Set();

  for (const [cgName, venueId] of Object.entries(CG_VENUE_ALIASES)) {
    if (!cgByVenue.has(cgName)) continue;
    if (!transformedVenues[venueId]) continue;
    matched.push({
      cgName,
      venueId,
      nameSim: 0,
      urlScore: 0,
      matchMethod: "alias",
    });
    matchedCgNames.add(cgName);
    usedOurIds.add(venueId);
  }

  // Score every remaining (CG venue, our venue) pair.
  // URL overlap takes absolute priority: any overlap beats any name-only match.
  // Within each tier, sort by score descending then name similarity descending.
  const candidates = [];
  for (const cgName of cgVenueNames) {
    const cgSets = cgUrlSets.get(cgName);
    for (const venueId of ourVenueIds) {
      const urlScore = urlOverlapScore(cgSets, ourUrlSets[venueId]);
      const ourName = getVenueName(venueId);
      const nameSim = venueNameSimilarity(cgName, ourName);

      if (urlScore > 0) {
        candidates.push({
          cgName,
          venueId,
          urlScore,
          nameSim,
          matchMethod: "url",
        });
      } else if (nameSim >= NAME_MATCH_THRESHOLD) {
        candidates.push({
          cgName,
          venueId,
          urlScore: 0,
          nameSim,
          matchMethod: "name",
        });
      }
    }
  }

  // URL matches always beat name-only matches; within each tier sort by score.
  candidates.sort((a, b) => {
    if (a.matchMethod !== b.matchMethod) {
      return a.matchMethod === "url" ? -1 : 1;
    }
    if (a.matchMethod === "url")
      return b.urlScore - a.urlScore || b.nameSim - a.nameSim;
    return b.nameSim - a.nameSim;
  });

  for (const candidate of candidates) {
    if (matchedCgNames.has(candidate.cgName)) continue;
    if (usedOurIds.has(candidate.venueId)) continue;
    matched.push({
      cgName: candidate.cgName,
      venueId: candidate.venueId,
      nameSim: candidate.nameSim,
      urlScore: candidate.urlScore,
      matchMethod: candidate.matchMethod,
    });
    matchedCgNames.add(candidate.cgName);
    usedOurIds.add(candidate.venueId);
  }

  const unmatchedCg = cgVenueNames.filter((n) => !matchedCgNames.has(n));
  const unmatchedOurs = ourVenueIds.filter((v) => !usedOurIds.has(v)).sort();

  return { matched, unmatchedCg, unmatchedOurs };
}

// ---------------------------------------------------------------------------
// Flatten performances
// ---------------------------------------------------------------------------

function flattenOurPerformances(showings) {
  const flat = [];
  if (!Array.isArray(showings)) return flat;
  for (const showing of showings) {
    for (const perf of showing.performances || []) {
      flat.push({
        showingTitle: showing.title,
        showingId: showing.showingId,
        showingUrl: showing.url || null,
        time: perf.time,
        bookingUrl: perf.bookingUrl,
      });
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Screening matching
// ---------------------------------------------------------------------------

// Rewrite a CG booking link into the form used in our data before comparison.
// Venue-specific fixes for cases where CG's link is our URL plus extra path.
function canonicalizeCgLink(link, venueId) {
  if (!link) return link;
  // Electric Cinema: CG links to /film/{slug}/film-times/{location} while our
  // showing.url is /film/{slug}/. Strip the film-times suffix so they match.
  if (venueId.startsWith("electriccinema.co.uk")) {
    return link.replace(/\/film-times\/[^/?#]+\/?(?=$|[?#])/, "");
  }
  return link;
}

// Match remaining CG screenings to ours by URL equality + time proximity.
// `cgNormUrls` / `ourNormUrls` are the pre-normalised URLs to compare (booking
// or showing). `offsets` lists the candidate shifts (ms) to subtract from CG's
// time before comparing; for each CG/our pair the smallest resulting delta wins.
// A non-zero offset only applies to CG timestamps within BST and recovers the
// venues whose CG times run 1 hour ahead (see BST_OFFSET_VENUES).
//
// Matches are assigned globally smallest-delta-first rather than in CG order, so
// a BST-shifted CG time can't greedily steal a same-URL screening that belongs
// to a different (correctly-timed) performance.
function matchByUrlAndTime(
  cgFlat,
  ourFlat,
  usedCgIdx,
  usedOurIdx,
  cgNormUrls,
  ourNormUrls,
  offsets,
  method,
  matchedPerfs,
) {
  const candidates = [];
  for (let ci = 0; ci < cgFlat.length; ci++) {
    if (usedCgIdx.has(ci) || !cgNormUrls[ci]) continue;
    const cgNorm = cgNormUrls[ci];
    const inBst = isDuringBST(cgFlat[ci].timeMs);

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi) || !ourNormUrls[oi]) continue;
      if (cgNorm !== ourNormUrls[oi]) continue;

      let bestDelta = Infinity;
      for (const offset of offsets) {
        if (offset && !inBst) continue;
        const delta = Math.abs(cgFlat[ci].timeMs - offset - ourFlat[oi].time);
        if (delta < bestDelta) bestDelta = delta;
      }
      if (bestDelta <= TIME_TOLERANCE_MS)
        candidates.push({ ci, oi, delta: bestDelta });
    }
  }

  candidates.sort((a, b) => a.delta - b.delta);
  for (const { ci, oi } of candidates) {
    if (usedCgIdx.has(ci) || usedOurIdx.has(oi)) continue;
    usedCgIdx.add(ci);
    usedOurIdx.add(oi);
    matchedPerfs.push({
      cg: cgFlat[ci],
      ours: ourFlat[oi],
      matchMethod: method,
    });
  }
}

function matchScreenings(cgFlat, ourFlat, venueId = "") {
  const matchedPerfs = [];
  const cgOnly = [];
  const ourOnly = [];

  const usedCgIdx = new Set();
  const usedOurIdx = new Set();

  const ourNormUrls = ourFlat.map((o) =>
    o.bookingUrl ? normalizeUrl(o.bookingUrl) : null,
  );
  const ourShowingNormUrls = ourFlat.map((o) =>
    o.showingUrl ? normalizeUrl(o.showingUrl) : null,
  );
  const ourPerfIds = ourFlat.map((o) =>
    o.bookingUrl ? extractPerfId(o.bookingUrl) : null,
  );
  const cgPerfIds = cgFlat.map((cg) =>
    cg.link ? extractPerfId(cg.link) : null,
  );
  const cgNormUrls = cgFlat.map((cg) =>
    cg.link ? normalizeUrl(canonicalizeCgLink(cg.link, venueId)) : null,
  );
  // Slug tokens: last path segment of CG links that have no query params (clean slug URLs).
  // Only computed for slug-style URLs; null for query-param URLs like BFI's old ASP format.
  const cgSlugTokens = cgFlat.map((cg) => {
    if (!cg.link) return null;
    try {
      const cleaned = cg.link.replace(/([^:])\/\/+/g, "$1/");
      const u = new URL(cleaned);
      if (u.search) return null; // has query params — not a clean slug URL
      const segments = u.pathname.split("/").filter(Boolean);
      const slug = segments[segments.length - 1];
      if (!slug) return null;
      return new Set(slug.split("-").filter(Boolean));
    } catch {
      return null;
    }
  });
  const ourTitleTokens = ourFlat.map(
    (o) => new Set(normalizeName(o.showingTitle).split(" ").filter(Boolean)),
  );

  // CG mis-parses BST datetimes for some venues, running 1 hour ahead of ours.
  // For those venues the URL+time passes also try a 1-hour-back interpretation.
  const timeOffsets = BST_OFFSET_VENUES.has(venueId) ? [0, BST_OFFSET_MS] : [0];

  // Primary: booking URL + time match
  // Time check prevents event-level URLs (e.g. TicketSource) from matching a
  // CG performance to a different performance of the same event in our data.
  matchByUrlAndTime(
    cgFlat,
    ourFlat,
    usedCgIdx,
    usedOurIdx,
    cgNormUrls,
    ourNormUrls,
    timeOffsets,
    "bookingUrl",
    matchedPerfs,
  );

  // Secondary: perf ID match
  for (let ci = 0; ci < cgFlat.length; ci++) {
    if (usedCgIdx.has(ci) || !cgPerfIds[ci]) continue;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi) || !ourPerfIds[oi]) continue;
      if (cgPerfIds[ci] === ourPerfIds[oi]) {
        usedCgIdx.add(ci);
        usedOurIdx.add(oi);
        matchedPerfs.push({
          cg: cgFlat[ci],
          ours: ourFlat[oi],
          matchMethod: "perfId",
        });
        break;
      }
    }
  }

  // Tertiary: showing URL + time match
  // For venues like Barbican where CG links to the event page and our showing.url
  // is also the event page (not the booking URL). Useful when perf ID isn't available.
  matchByUrlAndTime(
    cgFlat,
    ourFlat,
    usedCgIdx,
    usedOurIdx,
    cgNormUrls,
    ourShowingNormUrls,
    timeOffsets,
    "showingUrl",
    matchedPerfs,
  );

  // Quinary: URL slug vs title tokens + time match
  // For venues like BFI where CG uses clean slug URLs (no query params) and the
  // slug words are the same as our title words, just reordered.
  const SLUG_TITLE_THRESHOLD = 0.5;
  for (let ci = 0; ci < cgFlat.length; ci++) {
    if (usedCgIdx.has(ci) || !cgSlugTokens[ci]) continue;
    const slugWords = cgSlugTokens[ci];

    let bestOurIdx = -1;
    let bestSim = 0;
    let bestDelta = Infinity;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      if (cgPerfIds[ci] && ourPerfIds[oi] && cgPerfIds[ci] !== ourPerfIds[oi])
        continue;

      const delta = Math.abs(cgFlat[ci].timeMs - ourFlat[oi].time);
      if (delta > TIME_TOLERANCE_MS) continue;

      const titleWords = ourTitleTokens[oi];
      let intersection = 0;
      for (const w of slugWords) {
        if (titleWords.has(w)) intersection++;
      }
      const union = slugWords.size + titleWords.size - intersection;
      const sim = union > 0 ? intersection / union : 0;
      if (sim < SLUG_TITLE_THRESHOLD) continue;

      if (sim > bestSim || (sim === bestSim && delta < bestDelta)) {
        bestSim = sim;
        bestDelta = delta;
        bestOurIdx = oi;
      }
    }

    if (bestOurIdx >= 0) {
      usedCgIdx.add(ci);
      usedOurIdx.add(bestOurIdx);
      matchedPerfs.push({
        cg: cgFlat[ci],
        ours: ourFlat[bestOurIdx],
        matchMethod: "slugTitle",
      });
    }
  }

  // Quinary: title + time match (last resort)
  for (let ci = 0; ci < cgFlat.length; ci++) {
    if (usedCgIdx.has(ci)) continue;
    const cg = cgFlat[ci];
    const cgPerfId = cgPerfIds[ci];

    let bestOurIdx = -1;
    let bestTitleSim = 0;
    let bestDelta = Infinity;

    for (let oi = 0; oi < ourFlat.length; oi++) {
      if (usedOurIdx.has(oi)) continue;
      // If both sides have a perf ID and they differ, they can't be the same perf
      if (cgPerfId && ourPerfIds[oi] && cgPerfId !== ourPerfIds[oi]) continue;

      const delta = Math.abs(cg.timeMs - ourFlat[oi].time);
      if (delta > TIME_TOLERANCE_MS) continue;

      const titleSim = nameSimilarity(cg.filmTitle, ourFlat[oi].showingTitle);
      if (titleSim < 0.3) continue;

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
      usedCgIdx.add(ci);
      usedOurIdx.add(bestOurIdx);
      matchedPerfs.push({
        cg,
        ours: ourFlat[bestOurIdx],
        matchMethod: "time",
      });
    }
  }

  for (let ci = 0; ci < cgFlat.length; ci++) {
    if (!usedCgIdx.has(ci)) cgOnly.push(cgFlat[ci]);
  }
  for (let oi = 0; oi < ourFlat.length; oi++) {
    if (!usedOurIdx.has(oi)) ourOnly.push(ourFlat[oi]);
  }

  return { matchedPerfs, cgOnly, ourOnly };
}

// ---------------------------------------------------------------------------
// Per-venue analysis
// ---------------------------------------------------------------------------

async function analyzeVenue(cgScreenings, ourShowings, now, venueId) {
  const nowMs = now.getTime();
  const cgFlat = cgScreenings.filter((s) => s.timeMs >= nowMs);
  const ourFlat = flattenOurPerformances(ourShowings).filter(
    (p) => p.time >= nowMs,
  );

  const { matchedPerfs, cgOnly, ourOnly } = matchScreenings(
    cgFlat,
    ourFlat,
    venueId,
  );

  let cgOnlyGenuine = cgOnly.filter(
    (s) => !isKnownMismatch(s.filmTitle) && !isCgDataArtifact(s, venueId),
  );
  const cgOnlyKnown = cgOnly.filter(
    (s) => isKnownMismatch(s.filmTitle) || isCgDataArtifact(s, venueId),
  );

  // For certain venues, verify CG-only listings against the venue's own API to
  // filter out stale entries that CG still shows but the venue has removed.
  let cgOnlyStale = [];
  let cgOnlyStaleWarning = null;
  let cgOnlyStaleLabel = "Stale listings";

  async function verifyListings(verifyFn, cap, label) {
    cgOnlyStaleLabel = label;
    if (cgOnlyGenuine.length > cap) {
      cgOnlyStaleWarning = `Too many to verify (${cgOnlyGenuine.length} > cap ${cap}), shown unverified`;
    } else {
      const results = await Promise.all(
        cgOnlyGenuine.map(async (s) => {
          const valid = s.link ? await verifyFn(s.link, s) : true;
          return { s, valid };
        }),
      );
      cgOnlyStale = results.filter((r) => !r.valid).map((r) => r.s);
      cgOnlyGenuine = results.filter((r) => r.valid).map((r) => r.s);
    }
  }

  if (venueId.startsWith("cineworld.co.uk") && cgOnlyGenuine.length > 0) {
    await verifyListings(
      verifyCineworldListing,
      CW_VERIFY_CAP,
      "Stale Cineworld listings",
    );
  } else if (
    venueId.startsWith("thenickel.co.uk") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyNickelListing,
      NICKEL_VERIFY_CAP,
      "Stale Nickel listings",
    );
  } else if (venueId.startsWith("myvue.com") && cgOnlyGenuine.length > 0) {
    await verifyListings(
      verifyVueListing,
      VUE_VERIFY_CAP,
      "Stale Vue listings",
    );
  } else if (
    venueId.startsWith("everymancinema.com") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyEverymanListing,
      EVERYMAN_VERIFY_CAP,
      "Stale Everyman listings",
    );
  } else if (
    venueId.startsWith("picturehouses.com") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyPicturehousesListing,
      PICTUREHOUSES_VERIFY_CAP,
      "Stale Picturehouses listings",
    );
  } else if (
    venueId.startsWith("princecharlescinema.com") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyPrinceCharlesListing,
      PCC_VERIFY_CAP,
      "Stale Prince Charles Cinema listings",
    );
  } else if (venueId.startsWith("curzon.com") && cgOnlyGenuine.length > 0) {
    await verifyListings(
      verifyCurzonListing,
      CURZON_VERIFY_CAP,
      "Stale Curzon listings",
    );
  } else if (
    venueId.startsWith("forestcinema.co.uk") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyForestCinemaListing,
      FOREST_VERIFY_CAP,
      "Stale Forest Cinema listings",
    );
  } else if (
    venueId.startsWith("thecastlecinema.com") &&
    cgOnlyGenuine.length > 0
  ) {
    await verifyListings(
      verifyCastleCinemaListing,
      CASTLE_VERIFY_CAP,
      "Stale Castle Cinema listings",
    );
  } else if (venueId.startsWith("odeon.co.uk") && cgOnlyGenuine.length > 0) {
    await verifyListings(
      verifyOdeonListing,
      ODEON_VERIFY_CAP,
      "Stale Odeon listings",
    );
  }

  return {
    totalCg: cgFlat.length,
    totalOurs: ourFlat.length,
    matchedCount: matchedPerfs.length,
    cgOnlyCount: cgOnlyGenuine.length,
    cgOnlyKnownCount: cgOnlyKnown.length,
    cgOnlyStaleCount: cgOnlyStale.length,
    cgOnlyStaleWarning,
    cgOnlyStaleLabel,
    ourOnlyCount: ourOnly.length,
    cgOnly: cgOnlyGenuine,
    cgOnlyKnown,
    cgOnlyStale,
    ourOnly,
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

function formatReport(venueMatchResult, venueAnalyses, cgData) {
  const lines = [];
  const { matched, unmatchedCg, unmatchedOurs } = venueMatchResult;
  const totalCgVenues = matched.length + unmatchedCg.length;

  lines.push(`${c.bold}${c.cyan}CinemaGuide Screenings Comparison${c.reset}`);
  lines.push(`  CinemaGuide data fetched: ${cgData.metadata.fetchedAt}`);
  lines.push("");

  // Venue matching summary
  lines.push(`${c.bold}Venue Matching${c.reset}`);
  lines.push(`  CinemaGuide venues:       ${totalCgVenues}`);
  lines.push(
    `  Matched to our venues:    ${c.green}${matched.length}${c.reset}`,
  );
  lines.push(
    `  Unmatched CinemaGuide:    ${unmatchedCg.length > 0 ? c.yellow : ""}${unmatchedCg.length}${c.reset}`,
  );
  lines.push(
    `  Our venues (no CG match): ${c.dim}${unmatchedOurs.length}${c.reset}`,
  );
  lines.push("");

  // Screening summary
  let totalMatched = 0;
  let totalCgOnly = 0;
  let totalCgOnlyKnown = 0;
  let totalCgOnlyStale = 0;
  let totalOursOnly = 0;

  for (const analysis of Object.values(venueAnalyses)) {
    totalMatched += analysis.matchedCount;
    totalCgOnly += analysis.cgOnlyCount;
    totalCgOnlyKnown += analysis.cgOnlyKnownCount;
    totalCgOnlyStale += analysis.cgOnlyStaleCount;
    totalOursOnly += analysis.ourOnlyCount;
  }

  lines.push(`${c.bold}Screening Matching (across matched venues)${c.reset}`);
  lines.push(`  Screenings matched:       ${totalMatched}`);
  lines.push(
    `  CinemaGuide only:         ${totalCgOnly > 0 ? c.yellow : ""}${totalCgOnly}${c.reset}`,
  );
  if (totalCgOnlyKnown > 0) {
    lines.push(
      `  CG only (expected gaps):  ${c.dim}${totalCgOnlyKnown}${c.reset}`,
    );
  }
  if (totalCgOnlyStale > 0) {
    lines.push(
      `  CG only (stale listings): ${c.dim}${totalCgOnlyStale}${c.reset}`,
    );
  }
  lines.push(
    `  Ours only:                ${totalOursOnly > 0 ? c.yellow : ""}${totalOursOnly}${c.reset}`,
  );
  lines.push("");

  // Venues with CG-only screenings (most important: where might we be missing data?)
  const venuesWithCgOnly = matched
    .filter((m) => venueAnalyses[m.venueId]?.cgOnlyCount > 0)
    .sort(
      (a, b) =>
        venueAnalyses[b.venueId].cgOnlyCount -
        venueAnalyses[a.venueId].cgOnlyCount,
    );

  if (venuesWithCgOnly.length > 0) {
    lines.push(
      `${c.bold}${c.red}Venues with screenings in CinemaGuide but not ours (${venuesWithCgOnly.length})${c.reset}`,
    );
    for (const m of venuesWithCgOnly) {
      const n = venueAnalyses[m.venueId].cgOnlyCount;
      lines.push(
        `  ${c.red}${n.toString().padStart(4)}${c.reset}  ${m.venueId} ${c.dim}(CG: "${m.cgName}")${c.reset}`,
      );
    }
    lines.push("");
  }

  // Unmatched CinemaGuide venues
  if (unmatchedCg.length > 0) {
    lines.push(
      `${c.bold}${c.red}Unmatched CinemaGuide Venues (${unmatchedCg.length})${c.reset}`,
    );
    lines.push(
      `${c.dim}These CinemaGuide venues could not be matched to any of our venues.${c.reset}`,
    );
    lines.push("");
    for (const name of unmatchedCg) {
      lines.push(`  ${c.yellow}${name}${c.reset}`);
    }
    lines.push("");
  }

  // Venues with differences (genuine or known)
  const venuesWithDiffs = matched
    .filter((m) => {
      const a = venueAnalyses[m.venueId];
      return (
        a && (a.cgOnlyCount > 0 || a.ourOnlyCount > 0 || a.cgOnlyKnownCount > 0)
      );
    })
    .sort((a, b) => {
      const aa = venueAnalyses[a.venueId];
      const ba = venueAnalyses[b.venueId];
      return (
        ba.cgOnlyCount + ba.ourOnlyCount - (aa.cgOnlyCount + aa.ourOnlyCount)
      );
    });

  if (venuesWithDiffs.length > 0) {
    lines.push(
      `${c.bold}${c.yellow}Venues with Differences (${venuesWithDiffs.length})${c.reset}`,
    );
    lines.push("");

    for (const m of venuesWithDiffs) {
      const analysis = venueAnalyses[m.venueId];
      lines.push(
        `${c.yellow}--- ${m.venueId} ${"─".repeat(Math.max(0, 50 - m.venueId.length))}${c.reset}`,
      );
      const matchDetail =
        m.matchMethod === "alias"
          ? "hard-coded alias"
          : m.matchMethod === "url"
            ? `url overlap: ${(m.urlScore * 100).toFixed(0)}%, name sim: ${m.nameSim.toFixed(2)}`
            : `name-only match, sim: ${m.nameSim.toFixed(2)}`;
      lines.push(
        `    CinemaGuide: "${m.cgName}"  ${c.dim}[${matchDetail}]${c.reset}`,
      );
      lines.push(
        `    Screenings: ${analysis.matchedCount} matched (of ${analysis.totalCg} CG, ${analysis.totalOurs} ours)`,
      );

      if (analysis.cgOnlyCount > 0) {
        lines.push("");
        lines.push(
          `    ${c.red}CinemaGuide only (${analysis.cgOnlyCount}) — in their data, not ours:${c.reset}`,
        );
        for (const s of analysis.cgOnly.slice(0, 15)) {
          lines.push(`      ${s.filmTitle} @ ${formatTime(s.timeMs)}`);
          if (s.link) lines.push(`        ${c.dim}${s.link}${c.reset}`);
        }
        if (analysis.cgOnlyCount > 15) {
          lines.push(
            `      ${c.dim}... and ${analysis.cgOnlyCount - 15} more${c.reset}`,
          );
        }
      }

      if (analysis.ourOnlyCount > 0) {
        lines.push("");
        lines.push(
          `    ${c.cyan}Ours only (${analysis.ourOnlyCount}) — in our data, not CinemaGuide:${c.reset}`,
        );

        const cgOnlyTitles = new Set(
          analysis.cgOnly.map((s) => normalizeName(s.filmTitle)),
        );

        const ourOnlyByTitle = new Map();
        for (const p of analysis.ourOnly) {
          if (!ourOnlyByTitle.has(p.showingTitle))
            ourOnlyByTitle.set(p.showingTitle, []);
          ourOnlyByTitle.get(p.showingTitle).push(p);
        }
        const ourOnlyTitles = [...ourOnlyByTitle.entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        );
        const MAX_TITLES = 20;
        let titlesShown = 0;
        for (const [title, perfs] of ourOnlyTitles) {
          if (titlesShown >= MAX_TITLES) break;
          titlesShown++;
          const isMismatch = cgOnlyTitles.has(normalizeName(title));
          if (isMismatch) {
            for (const p of perfs) {
              lines.push(`      ${p.showingTitle} @ ${formatTime(p.time)}`);
              if (p.bookingUrl)
                lines.push(`        ${c.dim}${p.bookingUrl}${c.reset}`);
            }
          } else {
            const suffix =
              perfs.length > 1
                ? ` ${c.dim}(${perfs.length} performances)${c.reset}`
                : "";
            lines.push(`      ${title}${suffix}`);
          }
        }
        if (ourOnlyTitles.length > MAX_TITLES) {
          lines.push(
            `      ${c.dim}... and ${ourOnlyTitles.length - MAX_TITLES} more titles${c.reset}`,
          );
        }
      }

      if (analysis.cgOnlyKnownCount > 0) {
        lines.push("");
        lines.push(
          `    ${c.dim}Expected gaps — known mismatches we can't match (${analysis.cgOnlyKnownCount}):${c.reset}`,
        );
        const knownByTitle = new Map();
        for (const s of analysis.cgOnlyKnown) {
          knownByTitle.set(
            s.filmTitle,
            (knownByTitle.get(s.filmTitle) || 0) + 1,
          );
        }
        for (const [title, count] of [...knownByTitle.entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        )) {
          const suffix = count > 1 ? ` (${count} screenings)` : "";
          lines.push(`      ${c.dim}${title}${suffix}${c.reset}`);
        }
      }

      if (analysis.cgOnlyStaleCount > 0 || analysis.cgOnlyStaleWarning) {
        const label = analysis.cgOnlyStaleLabel || "Stale listings";
        lines.push("");
        if (analysis.cgOnlyStaleWarning) {
          lines.push(
            `    ${c.dim}${label} — ${analysis.cgOnlyStaleWarning}${c.reset}`,
          );
        } else {
          lines.push(
            `    ${c.dim}${label} — removed from venue but still in CG (${analysis.cgOnlyStaleCount}):${c.reset}`,
          );
          for (const s of analysis.cgOnlyStale) {
            lines.push(
              `      ${c.dim}${s.filmTitle} @ ${formatTime(s.timeMs)}${c.reset}`,
            );
            if (s.link) lines.push(`        ${c.dim}${s.link}${c.reset}`);
          }
        }
      }

      lines.push("");
    }
  }

  // Venues with no differences
  const venuesAllGood = matched.filter((m) => {
    const a = venueAnalyses[m.venueId];
    return (
      a &&
      a.cgOnlyCount === 0 &&
      a.ourOnlyCount === 0 &&
      a.cgOnlyKnownCount === 0
    );
  });

  if (venuesAllGood.length > 0) {
    lines.push(
      `${c.bold}${c.green}Venues with No Differences (${venuesAllGood.length})${c.reset}`,
    );
    for (const m of venuesAllGood) {
      const analysis = venueAnalyses[m.venueId];
      const matchDetail =
        m.matchMethod === "alias"
          ? "alias"
          : m.matchMethod === "url"
            ? `url: ${(m.urlScore * 100).toFixed(0)}%`
            : `name-only: ${m.nameSim.toFixed(2)}`;
      lines.push(
        `  ${c.green}✓${c.reset} ${m.venueId} ${c.dim}(CG: "${m.cgName}", ${matchDetail})${c.reset} — ${analysis.matchedCount} matched`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [cgDataPath, transformedDir] = process.argv.slice(2);

  if (!cgDataPath || !transformedDir) {
    console.error(
      "Usage: compare-cinemaguide-screenings.js <cinemaguide-data-path> <transformed-data-dir>",
    );
    process.exit(1);
  }

  console.log(`Loading CinemaGuide data from ${cgDataPath}...`);
  const cgData = loadCinemaguideData(cgDataPath);
  const cgByVenue = buildCinemaguideByVenue(cgData);
  const totalScreenings = [...cgByVenue.values()].reduce(
    (n, v) => n + v.length,
    0,
  );
  console.log(`  ${cgByVenue.size} venues, ${totalScreenings} screenings`);

  console.log(`Loading transformed data from ${transformedDir}...`);
  const transformedVenues = loadTransformedData(transformedDir);
  console.log(`  ${Object.keys(transformedVenues).length} venue files`);

  console.log("\nMatching venues...");
  const venueMatchResult = matchVenues(cgByVenue, transformedVenues);
  console.log(`  Matched: ${venueMatchResult.matched.length}`);
  console.log(
    `  Unmatched CinemaGuide: ${venueMatchResult.unmatchedCg.length}`,
  );
  console.log(`  Unmatched ours: ${venueMatchResult.unmatchedOurs.length}`);

  const now = new Date();
  console.log(`\nAnalysing screenings (from ${now.toISOString()})...`);
  const venueAnalyses = {};

  for (const m of venueMatchResult.matched) {
    const cgScreenings = cgByVenue.get(m.cgName) || [];
    const ourShowings = transformedVenues[m.venueId] || [];
    venueAnalyses[m.venueId] = await analyzeVenue(
      cgScreenings,
      ourShowings,
      now,
      m.venueId,
    );
  }

  console.log("");
  const report = formatReport(venueMatchResult, venueAnalyses, cgData);
  console.log(report);

  const hasMismatches = Object.values(venueAnalyses).some(
    (a) => a.cgOnlyCount > 0,
  );
  if (hasMismatches) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
