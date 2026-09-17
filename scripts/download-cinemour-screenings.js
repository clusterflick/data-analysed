const fs = require("fs");
const path = require("path");

// Cinemour (https://www.cinemour.com/) is a London cinema showtimes
// aggregator. Its `/api/in-cinemas` endpoint returns TMDB-backed film lists
// used to drive its homepage, bucketed by how "in cinemas" each film
// currently is — this is a film-level list, not per-venue screening times, so
// the comparison in compare-cinemour-screenings.js works at the film level.
const API_URL = "https://www.cinemour.com/api/in-cinemas";

async function main() {
  console.log(`Fetching in-cinemas data from ${API_URL}...`);

  const res = await fetch(API_URL, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
      Accept: "application/json",
      "Accept-Language": "en-GB,en;q=0.9",
      Referer: "https://www.cinemour.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const output = {
    metadata: {
      fetchedAt: new Date().toISOString(),
    },
    data,
  };

  const outputDir = path.join(__dirname, "..", "cinemour-data");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "cinemour-data.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Data saved to ${outputPath}`);
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (Array.isArray(value)) {
      console.log(`  ${key}: ${value.length} films`);
    }
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
