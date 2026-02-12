const { fetchJson } = require("scripts/common/utils");
const { cache, dailyCache } = require("scripts/common/cache");

const REPO = "clusterflick/data-combined";
const API_URL = `https://api.github.com/repos/${REPO}/releases`;
const searchTerm = process.argv[2] || "My Father's Shadow";
const NUM_DAYS = parseInt(process.argv[3], 10) || 30;

async function fetchReleaseList() {
  return dailyCache("track-movie-releases", async () => {
    console.log(`Fetching release list from ${REPO}...`);

    // Fetch multiple pages to ensure we cover enough days
    const page1 = await fetchJson(`${API_URL}?per_page=100&page=1`);
    if (page1.length < 100) return page1;

    const page2 = await fetchJson(`${API_URL}?per_page=100&page=2`);
    return [...page1, ...page2];
  });
}

function getLastReleasePerDay(releases, numDays) {
  // Sort by published_at descending (most recent first)
  const sorted = [...releases].sort(
    (a, b) => new Date(b.published_at) - new Date(a.published_at),
  );

  // Group by date, take first (most recent) per day
  const byDay = new Map();
  for (const release of sorted) {
    const date = release.published_at.split("T")[0];
    if (!byDay.has(date)) {
      byDay.set(date, release);
    }
  }

  // Return the most recent numDays entries, newest first
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, numDays)
    .map(([date, release]) => ({ date, release }));
}

async function fetchCombinedData(release) {
  const tag = release.tag_name;
  const asset = release.assets.find((a) => a.name === "combined-data.json");
  if (!asset) return null;

  return cache(`track-movie-combined-${tag}`, async () => {
    process.stdout.write(`  Downloading combined data for ${tag}...`);
    const data = await fetchJson(asset.browser_download_url);
    console.log(" done");
    return data;
  });
}

function searchMovies(data, term) {
  const lowerTerm = term.toLowerCase();
  const results = [];

  for (const movie of Object.values(data.movies)) {
    const movieTitleMatches = movie.title.toLowerCase().includes(lowerTerm);

    for (const showing of Object.values(movie.showings)) {
      const displayTitle = showing.title || movie.title;
      const showingTitleMatches = displayTitle
        .toLowerCase()
        .includes(lowerTerm);

      if (!movieTitleMatches && !showingTitleMatches) continue;

      const performanceCount = movie.performances.filter(
        (p) => p.showingId === showing.id,
      ).length;

      const venue = data.venues[showing.venueId];
      const venueName = venue ? venue.name : "Unknown Venue";

      results.push({
        title: displayTitle,
        venueName,
        performanceCount,
        showingId: showing.id,
      });
    }
  }

  // Sort by venue name, then by title for consistent output
  results.sort(
    (a, b) =>
      a.venueName.localeCompare(b.venueName) || a.title.localeCompare(b.title),
  );

  return results;
}

function formatDate(dateStr) {
  const date = new Date(dateStr + "T12:00:00Z");
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
  return `${days[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function summarize(results) {
  const showingCount = results.length;
  const performanceCount = results.reduce(
    (sum, r) => sum + r.performanceCount,
    0,
  );
  const venueCount = new Set(results.map((r) => r.venueName)).size;
  return { showingCount, performanceCount, venueCount };
}

function formatDelta(current, previous) {
  if (!previous) return "";

  const diffs = [
    {
      label: "showing",
      delta: current.showingCount - previous.showingCount,
    },
    {
      label: "performance",
      delta: current.performanceCount - previous.performanceCount,
    },
    {
      label: "venue",
      delta: current.venueCount - previous.venueCount,
    },
  ];

  const allZero = diffs.every((d) => d.delta === 0);
  if (allZero) return "  [no change vs previous day]";

  const parts = diffs
    .filter((d) => d.delta !== 0)
    .map((d) => {
      const sign = d.delta > 0 ? "+" : "";
      const plural = Math.abs(d.delta) !== 1 ? "s" : "";
      return `${sign}${d.delta} ${d.label}${plural}`;
    });

  return `  [${parts.join(", ")} vs previous day]`;
}

function plural(count, word) {
  return `${count} ${word}${count !== 1 ? "s" : ""}`;
}

async function trackMovie() {
  const releases = await fetchReleaseList();
  const dailyReleases = getLastReleasePerDay(releases, NUM_DAYS);

  console.log(
    `\nDownloading ${dailyReleases.length} days of combined data...\n`,
  );

  // Fetch all combined data (oldest first for delta calculation)
  const reversedReleases = [...dailyReleases].reverse();
  const dayResults = [];
  let previousSummary = null;

  for (const { date, release } of reversedReleases) {
    const data = await fetchCombinedData(release);

    if (!data) {
      dayResults.push({ date, results: [], summary: null, delta: "" });
      previousSummary = null;
      continue;
    }

    const results = searchMovies(data, searchTerm);
    const summary = summarize(results);
    const delta = formatDelta(summary, previousSummary);

    dayResults.push({ date, results, summary, delta });
    previousSummary = summary;
  }

  // Display newest first
  console.log(
    `\nDay-by-day tracking for "${searchTerm}" (last ${NUM_DAYS} days)`,
  );
  console.log("=".repeat(60));
  console.log("");

  for (const { date, results, summary, delta } of [...dayResults].reverse()) {
    if (!summary) {
      console.log(`${formatDate(date)} [no data available]`);
      console.log("");
      continue;
    }

    if (results.length === 0) {
      console.log(`${formatDate(date)} [not found]`);
      if (delta) console.log(delta);
      console.log("");
      continue;
    }

    const { showingCount, performanceCount, venueCount } = summary;
    console.log(
      `${formatDate(date)} [${plural(showingCount, "showing")}, ${plural(performanceCount, "performance")}, ${plural(venueCount, "venue")}]`,
    );

    for (const { title, performanceCount, venueName } of results) {
      console.log(
        `  - "${title}" (${plural(performanceCount, "performance")}) @ ${venueName}`,
      );
    }

    if (delta) console.log(delta);
    console.log("");
  }
}

trackMovie();
