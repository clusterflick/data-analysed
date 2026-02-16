const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Token extraction from UKCA website
// ---------------------------------------------------------------------------

const UKCA_SEARCH_URL =
  "https://accessiblescreeningsuk.co.uk/search-results/?location=London&screeningType=All";
const UKCA_BASE_URL = "https://accessiblescreeningsuk.co.uk";

async function extractTokens() {
  console.log("Extracting JWT tokens from UKCA website...");

  // Step 1: Fetch the search results page HTML
  const htmlRes = await fetch(UKCA_SEARCH_URL);
  if (!htmlRes.ok) {
    throw new Error(`Failed to fetch UKCA page: ${htmlRes.status}`);
  }
  const html = await htmlRes.text();

  // Step 2: Find the chunk mapping and locate the page component JS file
  // Gatsby embeds chunk mapping in a script tag with id "gatsby-chunk-mapping"
  // or inlines it. We look for the component---src-templates-page-tsx key.
  const chunkMatch = html.match(
    /component---src-templates-page-tsx[^"]*?":\s*\[\s*"([^"]+)"\s*\]/,
  );

  let jsUrl;
  if (chunkMatch) {
    // The chunk mapping gives us the hash; construct the JS filename
    const chunkFile = chunkMatch[1];
    jsUrl = `${UKCA_BASE_URL}/${chunkFile}`;
  } else {
    // Fallback: look for the script tag directly
    const scriptMatch = html.match(
      /src="([^"]*component---src-templates-page-tsx[^"]*)"/,
    );
    if (!scriptMatch) {
      throw new Error(
        "Could not find component---src-templates-page-tsx JS bundle in UKCA page",
      );
    }
    jsUrl = scriptMatch[1].startsWith("http")
      ? scriptMatch[1]
      : `${UKCA_BASE_URL}${scriptMatch[1]}`;
  }

  console.log(`  Fetching JS bundle: ${jsUrl}`);

  // Step 3: Fetch the JS bundle
  const jsRes = await fetch(jsUrl);
  if (!jsRes.ok) {
    throw new Error(`Failed to fetch JS bundle: ${jsRes.status}`);
  }
  const jsCode = await jsRes.text();

  // Step 4: Extract the two Bearer tokens
  // Theater list token: used with graph.allocine.fr
  // Showtimes token: used with api.webediamovies.pro
  const tokenPattern =
    /Authorization:"Bearer (eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/g;
  const tokens = [];
  let match;
  while ((match = tokenPattern.exec(jsCode)) !== null) {
    tokens.push(match[1]);
  }

  if (tokens.length < 2) {
    throw new Error(
      `Expected 2 JWT tokens in JS bundle, found ${tokens.length}`,
    );
  }

  // The first token in the bundle is for the theater list API (graph.allocine.fr)
  // The second is for the showtimes API (api.webediamovies.pro)
  // Verify by checking the surrounding context
  const allocineIdx = jsCode.indexOf("graph.allocine.fr");
  const webediaIdx = jsCode.indexOf("api.webediamovies.pro");

  let theaterToken, showtimeToken;
  if (allocineIdx >= 0 && webediaIdx >= 0) {
    // Find which token appears near which URL
    const token1Idx = jsCode.indexOf(tokens[0]);
    const token2Idx = jsCode.indexOf(tokens[1]);

    if (Math.abs(token1Idx - allocineIdx) < Math.abs(token1Idx - webediaIdx)) {
      theaterToken = tokens[0];
      showtimeToken = tokens[1];
    } else {
      theaterToken = tokens[1];
      showtimeToken = tokens[0];
    }
  } else {
    // Fallback: assume order as found
    theaterToken = tokens[0];
    showtimeToken = tokens[1];
  }

  console.log(`  Theater list token: ${theaterToken.substring(0, 30)}...`);
  console.log(`  Showtimes token:    ${showtimeToken.substring(0, 30)}...`);

  return { theaterToken, showtimeToken };
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function queryTheaterList(query, token) {
  const res = await fetch("https://graph.allocine.fr/v1/ukca/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Theater list API error: ${res.status}`);
  }
  const data = await res.json();
  if (!data.data || !data.data.theaterList) {
    throw new Error(
      `Unexpected theater list response: ${JSON.stringify(data).substring(0, 200)}`,
    );
  }
  return data.data.theaterList;
}

async function queryShowtimes(query, token) {
  const res = await fetch("https://api.webediamovies.pro/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Showtimes API error: ${res.status}`);
  }
  const data = await res.json();
  if (!data.data || !data.data.external) {
    throw new Error(
      `Unexpected showtimes response: ${JSON.stringify(data).substring(0, 200)}`,
    );
  }
  return data.data.external.showtimes.byTheater;
}

// ---------------------------------------------------------------------------
// Fetch all London theaters (with pagination)
// ---------------------------------------------------------------------------

async function fetchAllTheaters(token, toDate) {
  const allTheaters = [];
  let afterCursor = null;
  let page = 1;

  while (true) {
    const afterClause = afterCursor !== null ? `after: "${afterCursor}",` : "";

    const query = `
      query {
        theaterList(
          affiliation: {
            activity: THEATER_TRADE_GROUP,
            companyId: "Q29tcGFueToxMDAwMDkyMTEz"
          },
          ${afterClause}
          countries: [UNITED_KINGDOM],
          first: 120,
          order: [ALPHABETICAL],
          search: "London"
        ) {
          edges {
            node {
              id
              name
              location {
                address
                city
                country
                region
                zip
              }
              coordinates {
                latitude
                longitude
              }
              screens {
                accessibility
                name
              }
              tags {
                list
              }
              url
              showtimesDates(
                country: [UNITED_KINGDOM]
                to: "${toDate}"
              )
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    console.log(`  Fetching theater list page ${page}...`);
    const result = await queryTheaterList(query, token);
    const edges = result.edges || [];
    allTheaters.push(...edges.map((e) => e.node));

    if (result.pageInfo.hasNextPage) {
      afterCursor = result.pageInfo.endCursor;
      page++;
    } else {
      break;
    }
  }

  return allTheaters;
}

// ---------------------------------------------------------------------------
// Fetch showtimes for a single theater
// ---------------------------------------------------------------------------

function extractShortId(base64Id) {
  const decoded = Buffer.from(base64Id, "base64").toString("utf-8");
  // Format: "Theater:X0XWE" -> "X0XWE"
  const parts = decoded.split(":");
  return parts.length > 1 ? parts[1] : decoded;
}

async function fetchShowtimesForTheater(shortId, toDate, token) {
  const query = `
    {
      external {
        showtimes {
          byTheater(
            to: "${toDate}",
            theater: "${shortId}"
          ) {
            movie {
              id
              originalTitle: title
              en_GB: localeData(locale: "en_GB") {
                title
                poster
              }
              fallback: localeData(locale: "en_US") {
                title
                poster
              }
            }
            showtimes {
              startsAt
              tags
              data {
                ticketing {
                  urls
                }
              }
            }
          }
        }
      }
    }
  `;

  return await queryShowtimes(query, token);
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  // Extract tokens from the UKCA website
  const { theaterToken, showtimeToken } = await extractTokens();

  // Calculate toDate: ~3 weeks from now
  const toDate = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  console.log(`\nDate range: today to ${toDate}`);

  // Fetch all London theaters
  console.log("\nFetching London theaters...");
  const theaters = await fetchAllTheaters(theaterToken, toDate);
  console.log(`  Found ${theaters.length} theaters`);

  // Filter to theaters that have upcoming showtimes
  const theatersWithShowtimes = theaters.filter(
    (t) => t.showtimesDates && t.showtimesDates.length > 0,
  );
  console.log(
    `  ${theatersWithShowtimes.length} theaters have upcoming showtimes`,
  );

  // Fetch showtimes for each theater
  console.log("\nFetching showtimes per theater...");
  const showtimes = {};
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < theatersWithShowtimes.length; i++) {
    const theater = theatersWithShowtimes[i];
    const shortId = extractShortId(theater.id);

    process.stdout.write(
      `  [${i + 1}/${theatersWithShowtimes.length}] ${theater.name}... `,
    );

    try {
      const result = await fetchShowtimesForTheater(
        shortId,
        toDate,
        showtimeToken,
      );
      showtimes[shortId] = result || [];
      const showCount = (result || []).reduce(
        (sum, m) => sum + (m.showtimes ? m.showtimes.length : 0),
        0,
      );
      console.log(`${showCount} showtimes`);
      successCount++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      showtimes[shortId] = [];
      failCount++;
    }

    // Respectful delay between requests
    if (i < theatersWithShowtimes.length - 1) {
      await delay(300);
    }
  }

  // Prepare output
  const output = {
    metadata: {
      fetchedAt: new Date().toISOString(),
      toDate,
      theaterCount: theaters.length,
      theatersWithShowtimes: theatersWithShowtimes.length,
      showtimesFetched: successCount,
      showtimesFailed: failCount,
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
    `  ${theaters.length} theaters, ${successCount} showtimes fetched (${failCount} failed)`,
  );
  console.log(`  Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
