const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// UKCA (Accessible Screenings UK) data source
//
// The site proxies AlloCiné/Webedia's GraphQL through its own endpoint at
// /api/data-api, which requires no auth token. Two queries are used:
//   - `theaters`            → cinemas within a radius of central London
//   - `theater(id).schedule → per-cinema showtimes for a date range
//
// The theater list is fetched by geographic radius (aroundCoords + maxDistance,
// in km) rather than a fuzzy `search: "London"` text query. The text search both
// let in false positives (e.g. "Boldon" is within edit-distance 2 of "London")
// and missed outer-London venues whose names don't contain the word "London"
// (Croydon, Richmond, Walthamstow, ...). Results are then filtered precisely to
// the Greater London (GLA) boundary polygon.
//
// The output (ukca-data.json) is shaped to match what
// compare-accessible-screenings.js expects, so that script needs no changes:
//   - theater.id is a base64 "Theater:<code>" string (see extractShortId there)
//   - showtimes are keyed by the short theater code
// ---------------------------------------------------------------------------

const ORIGIN = "https://accessiblescreeningsuk.co.uk";
const REFERER = `${ORIGIN}/search-results/?location=London&screeningType=All`;
const API_URL = `${ORIGIN}/api/data-api`;
const AFFILIATION_ID = "1000092113";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";

async function graphql(query, variables) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Origin: ORIGIN,
      Referer: REFERER,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`API HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.errors) {
    throw new Error(
      `GraphQL error: ${JSON.stringify(body.errors).substring(0, 300)}`,
    );
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Shape mapping — new API → the shape compare-accessible-screenings.js expects
// ---------------------------------------------------------------------------

// Encode a short theater code back into the base64 "Theater:<code>" form so the
// comparison script's extractShortId() decodes it to the code again.
function encodeTheaterId(code) {
  return Buffer.from(`Theater:${code}`).toString("base64");
}

// Screen tags look like "Screen.Accessibility.AudioDescription"; the comparison
// script checks screen.accessibility for "AUDIO_DESCRIPTION" (SCREAMING_SNAKE).
function mapScreenAccessibility(tags) {
  const result = [];
  for (const tag of tags || []) {
    if (!tag.startsWith("Screen.Accessibility.")) continue;
    result.push(
      tag
        .replace("Screen.Accessibility.", "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase(),
    );
  }
  return result;
}

function mapTheater(node) {
  return {
    id: encodeTheaterId(node.id),
    name: node.name,
    url: node.url,
    location: {
      address: node.address?.address ?? null,
      city: node.address?.city ?? null,
      region: node.address?.state ?? null,
      zip: node.address?.zip ?? null,
      country: "United Kingdom",
    },
    coordinates: node.geocoordinates
      ? {
          latitude: node.geocoordinates.latitude,
          longitude: node.geocoordinates.longitude,
        }
      : null,
    screens: (node.screens || []).map((s) => ({
      name: s.name,
      accessibility: mapScreenAccessibility(s.tags),
    })),
    tags: { list: node.tags || [] },
    opening: node.opening?.status ?? null,
    // Filled in once the theater's schedule has been fetched.
    showtimesDates: [],
  };
}

// A ticketing entry may carry a real cinema booking URL (provider DEFAULT) and a
// RELAY redirect wrapper. Prefer the DEFAULT booking URLs — those match our data.
function pickBookingUrls(ticketingUrls) {
  const list = ticketingUrls || [];
  const preferred = list
    .filter((t) => t.provider === "DEFAULT" && t.url)
    .map((t) => t.url);
  if (preferred.length > 0) return preferred;
  return list.filter((t) => t.url).map((t) => t.url);
}

function mapSchedule(scheduleNodes) {
  return (scheduleNodes || []).map((node) => ({
    movie: {
      id: node.movie?.id ?? null,
      originalTitle: node.movie?.title ?? null,
      en_GB: node.movie?.en_GB
        ? {
            title: node.movie.en_GB.title,
            poster: node.movie.en_GB.poster?.url ?? null,
          }
        : null,
    },
    showtimes: (node.showtimes || []).map((s) => ({
      startsAt: s.startsAt,
      tags: s.attributes || [],
      data: { ticketing: [{ urls: pickBookingUrls(s.ticketingUrls) }] },
    })),
  }));
}

function scheduleDates(scheduleNodes) {
  const dates = new Set();
  for (const node of scheduleNodes || []) {
    for (const s of node.showtimes || []) {
      if (s.startsAt) dates.add(s.startsAt.substring(0, 10));
    }
  }
  return [...dates].sort();
}

// ---------------------------------------------------------------------------
// Greater London geographic filtering
// ---------------------------------------------------------------------------

// Central London (Charing Cross-ish). The radius only needs to comfortably
// enclose the whole GLA area — the boundary polygon does the precise cut — so a
// generous value avoids clipping edge venues while keeping the request cheap.
const LONDON_CENTRE = { latitude: 51.5074, longitude: -0.1278 };
const SEARCH_RADIUS_KM = 40;

const GLA_BOUNDARY_PATH = path.join(
  __dirname,
  "..",
  "data",
  "London_GLA_Boundary.geojson",
);

// Load the GLA boundary as an array of rings ([outerRing, ...holes]), each a
// list of [lon, lat] pairs.
function loadGlaPolygon() {
  const geojson = JSON.parse(fs.readFileSync(GLA_BOUNDARY_PATH, "utf-8"));
  return geojson.features[0].geometry.coordinates;
}

// Ray-casting point-in-polygon test over a single GeoJSON ring.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// True when the point is inside the outer ring but not inside any hole.
function pointInPolygon(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(lon, lat, rings[k])) return false;
  }
  return true;
}

function isInGreaterLondon(theater, glaPolygon) {
  const coords = theater.coordinates;
  if (!coords) return false;
  return pointInPolygon(coords.longitude, coords.latitude, glaPolygon);
}

// ---------------------------------------------------------------------------
// Fetch all theaters near London (paginated by offset)
// ---------------------------------------------------------------------------

const THEATERS_QUERY = `
  query GetTheaters(
    $limit: Int!
    $offset: Int!
    $aroundCoords: TheaterCoordinatesInput
    $maxDistance: Int
  ) {
    theaters(
      affiliationId: "${AFFILIATION_ID}"
      iso_3166_1_a2: "GB"
      limit: $limit
      offset: $offset
      aroundCoords: $aroundCoords
      maxDistance: $maxDistance
    ) {
      totalCount
      nodes {
        id
        name
        url
        address { address city state zip }
        geocoordinates { latitude longitude }
        tags
        screens { name tags }
        opening { status }
      }
    }
  }
`;

async function fetchAllTheaters() {
  const limit = 120;
  let offset = 0;
  const nodes = [];

  while (true) {
    const page = offset / limit + 1;
    console.log(`  Fetching theater list page ${page} (offset ${offset})...`);
    const data = await graphql(THEATERS_QUERY, {
      limit,
      offset,
      aroundCoords: LONDON_CENTRE,
      maxDistance: SEARCH_RADIUS_KM,
    });
    const { totalCount, nodes: pageNodes } = data.theaters;
    nodes.push(...(pageNodes || []));

    if (nodes.length >= totalCount || (pageNodes || []).length === 0) break;
    offset += limit;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Fetch showtimes (schedule) for a single theater
// ---------------------------------------------------------------------------

const SCHEDULE_QUERY = `
  query GetSchedule(
    $id: ID!
    $from: DateTimeWithoutTimeZone
    $to: DateTimeWithoutTimeZone
  ) {
    theater(id: $id) {
      schedule(from: $from, to: $to) {
        totalCount
        nodes {
          movie {
            id
            title
            en_GB: locale(locale: "en_GB") { title poster { url } }
          }
          showtimes {
            internalId
            startsAt
            attributes
            ticketingUrls { provider url }
            screen { name tags }
          }
        }
      }
    }
  }
`;

async function fetchSchedule(code, from, to) {
  const data = await graphql(SCHEDULE_QUERY, { id: code, from, to });
  return data.theater?.schedule?.nodes || [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  // Date range: today (start of day) to ~3 weeks out.
  const now = new Date();
  const from = `${now.toISOString().split("T")[0]}T00:00:00`;
  const toDate = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const to = `${toDate}T00:00:00`;

  console.log(`Date range: ${from} to ${to}`);

  // Fetch theaters within the search radius of central London
  console.log(`\nFetching theaters within ${SEARCH_RADIUS_KM}km of London...`);
  const rawTheaters = await fetchAllTheaters();
  console.log(`  Found ${rawTheaters.length} theaters`);

  // Filter precisely to the Greater London (GLA) boundary. Keep the raw node and
  // its mapped form paired so the schedule loop below stays in sync.
  const glaPolygon = loadGlaPolygon();
  const pairs = rawTheaters
    .map((raw) => ({ raw, theater: mapTheater(raw) }))
    .filter(({ theater }) => isInGreaterLondon(theater, glaPolygon));
  const excludedCount = rawTheaters.length - pairs.length;
  console.log(
    `  ${pairs.length} within Greater London boundary (${excludedCount} outside, filtered out)`,
  );

  const theaters = pairs.map((p) => p.theater);

  // Fetch showtimes (schedule) for each theater
  console.log("\nFetching showtimes per theater...");
  const showtimes = {};
  let successCount = 0;
  let failCount = 0;
  let withShowtimes = 0;

  for (let i = 0; i < pairs.length; i++) {
    const { raw, theater } = pairs[i];

    process.stdout.write(`  [${i + 1}/${pairs.length}] ${raw.name}... `);

    try {
      const scheduleNodes = await fetchSchedule(raw.id, from, to);
      showtimes[raw.id] = mapSchedule(scheduleNodes);
      theater.showtimesDates = scheduleDates(scheduleNodes);

      const showCount = (showtimes[raw.id] || []).reduce(
        (sum, m) => sum + (m.showtimes ? m.showtimes.length : 0),
        0,
      );
      console.log(`${showCount} showtimes`);
      if (showCount > 0) withShowtimes++;
      successCount++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      showtimes[raw.id] = [];
      failCount++;
    }

    // Respectful delay between requests
    if (i < pairs.length - 1) {
      await delay(300);
    }
  }

  // Prepare output
  const output = {
    metadata: {
      fetchedAt: new Date().toISOString(),
      from,
      to: toDate,
      theaterCount: theaters.length,
      theatersWithShowtimes: withShowtimes,
      schedulesFetched: successCount,
      schedulesFailed: failCount,
      elapsedMs: Date.now() - startTime,
    },
    theaters,
    showtimes,
  };

  // Write output
  const outputDir = path.join(__dirname, "..", "accessible-screenings-data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "ukca-data.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\nData saved to ${outputPath}`);
  console.log(
    `  ${theaters.length} theaters, ${withShowtimes} with showtimes (${failCount} failed)`,
  );
  console.log(`  Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
