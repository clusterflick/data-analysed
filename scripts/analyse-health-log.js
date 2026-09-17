// Reads the venue health log back and says what it shows.
//
// Usage: node scripts/analyse-health-log.js [days]
//
// The log is published one release per London day (see venue-health.yml), so a
// window spanning more than today means fetching several releases and stitching
// them together. Cycles are ordered globally rather than per day: a venue that
// changed between the last cycle of one day and the first of the next changed
// once, not twice.
//
// Two things the report deliberately does not do:
//
//   - Sum counts across chains. A chain answering with individual performances
//     and one answering with a film x date matrix are counting different
//     things, so a total over both is a number with no meaning - and Omniplex
//     answers with neither, only the size of each axis. `films` and `dates` are
//     comparable everywhere; anything finer-grained is reported per chain,
//     labelled with what it counts.
//
//   - Group rows by the date in `at`. That field is UTC while the release tag
//     is London, so through BST the day's first cycle carries the previous
//     date. The release a row came from is the grouping key, and it is carried
//     through as `day` below.

const { fetchJson, fetchText } = require("scripts/common/utils");
const { cache, dailyCache } = require("scripts/common/cache");

const REPO = "clusterflick/data-analysed";
const API_URL = `https://api.github.com/repos/${REPO}/releases`;
const ASSET = "health-log.jsonl";
const NUM_DAYS = parseInt(process.argv[2], 10) || 14;

// Unauthenticated calls share a per-IP rate limit that repeated runs exhaust
// quickly, so send a token whenever one is available
const TOKEN =
  process.env.PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const requestOptions = {
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {}),
  },
};

// What a chain's third count is called, keyed off the row's own `granularity`
// so a chain changing what it reports shows up here rather than being silently
// miscounted.
//
// Omniplex has no third count. It publishes one date at a time, so a film x
// date matrix would cost it a request per published date, and its probe reports
// the size of each axis instead - `films` and `dates` are the whole of its
// `counts`, and both already have a column of their own. `null` says that
// rather than naming a metric: summing an absent key would print a `0` that
// reads as "no showings" instead of "not counted". A granularity missing from
// this table altogether is a different thing - a chain reporting something this
// report has never been taught - and still shows as `?`.
const GRANULARITY_METRIC = {
  "film-date": "filmDatePairs",
  performance: "performances",
  "film-and-date-totals": null,
};

const londonHour = (at) =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(at)),
  );

const chainOf = (venue) => venue.split("-")[0];

async function fetchReleaseList() {
  return dailyCache("health-log-releases", async () => {
    console.log(`Fetching release list from ${REPO}...`);
    const page1 = await fetchJson(
      `${API_URL}?per_page=100&page=1`,
      requestOptions,
    );
    if (page1.length < 100) return page1;
    const page2 = await fetchJson(
      `${API_URL}?per_page=100&page=2`,
      requestOptions,
    );
    return [...page1, ...page2];
  });
}

// Only the health releases: this repo tags others, and a release whose asset
// has not been written yet is not an error, just not part of the window.
function getHealthReleases(releases, numDays) {
  return releases
    .filter(({ tag_name }) => /^\d{8}$/.test(tag_name))
    .filter(({ assets }) => assets.some(({ name }) => name === ASSET))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name))
    .slice(0, numDays)
    .reverse();
}

async function fetchDayLog(release) {
  const tag = release.tag_name;
  const asset = release.assets.find(({ name }) => name === ASSET);

  // Today's log is still being appended to, so it must not be cached under a
  // key that outlives the cycle that wrote it.
  const isToday =
    tag ===
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
      .format(new Date())
      .replaceAll("-", "");

  const read = async () => {
    process.stdout.write(`  Downloading ${ASSET} for ${tag}...`);
    const body = await fetchText(asset.browser_download_url);
    console.log(" done");
    return body;
  };

  const body = isToday ? await read() : await cache(`health-log-${tag}`, read);

  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ ...JSON.parse(line), day: tag }));
}

// One entry per cycle, in the order the cycles ran.
function toCycles(rows) {
  const byCycle = new Map();
  for (const row of rows) {
    if (!byCycle.has(row.cycle)) {
      byCycle.set(row.cycle, { cycle: row.cycle, day: row.day, rows: [] });
    }
    byCycle.get(row.cycle).rows.push(row);
  }
  for (const cycle of byCycle.values()) {
    cycle.at = cycle.rows.reduce(
      (a, r) => (r.at < a ? r.at : a),
      cycle.rows[0].at,
    );
    cycle.hour = londonHour(cycle.at);
  }
  return [...byCycle.values()].sort((a, b) => a.at.localeCompare(b.at));
}

function reportSampling(cycles) {
  console.log("\nSampling");
  console.log("=".repeat(72));
  console.log("The log is only as good as the regularity of its sampling.\n");

  const byDay = new Map();
  for (const cycle of cycles) {
    if (!byDay.has(cycle.day)) byDay.set(cycle.day, []);
    byDay.get(cycle.day).push(cycle);
  }

  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const hours = byDay.get(day).map(({ hour }) => hour);
    const seen = new Set(hours);
    // The window's first and last days are partial by definition, so only look
    // for holes between the first and last cycle actually recorded that day.
    const from = Math.min(...hours);
    const to = Math.max(...hours);
    const missing = [];
    for (let hour = from; hour <= to; hour += 1) {
      if (!seen.has(hour)) missing.push(String(hour).padStart(2, "0"));
    }
    const span = `${String(from).padStart(2, "0")}:00-${String(to).padStart(2, "0")}:00`;
    const note =
      missing.length > 0
        ? `gaps at ${missing.join(", ")}`
        : seen.size === 24
          ? "complete"
          : "no gaps within span";
    console.log(
      `  ${day}  ${String(seen.size).padStart(2)} cycles  ${span.padEnd(13)} ${note}`,
    );
  }

  const venueCounts = new Set(cycles.map(({ rows }) => rows.length));
  if (venueCounts.size > 1) {
    console.log(
      `\n  Venues per cycle varies: ${[...venueCounts].sort((a, b) => a - b).join(", ")}`,
    );
  }
}

function reportObservations(cycles) {
  console.log("\n\nObservations");
  console.log("=".repeat(72));
  console.log("Anything other than `ok`, by chain.\n");

  const byChain = new Map();
  for (const { cycle, rows } of cycles) {
    for (const row of rows) {
      const chain = chainOf(row.venue);
      if (!byChain.has(chain)) {
        byChain.set(chain, { total: 0, kinds: {}, cyclesWith: {} });
      }
      const entry = byChain.get(chain);
      entry.total += 1;
      const kind = row.reason?.kind ?? "ok";
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + 1;
      // A chain probe answers for the whole estate at once, so a bad cycle
      // marks every venue. Counting rows alone makes one bad cycle look like a
      // sustained problem; the cycle count says which it was.
      (entry.cyclesWith[kind] ??= new Set()).add(cycle);
    }
  }

  let anything = false;
  for (const chain of [...byChain.keys()].sort()) {
    const { total, kinds } = byChain.get(chain);
    const notOk = Object.entries(kinds).filter(([kind]) => kind !== "ok");
    if (notOk.length === 0) continue;
    anything = true;
    const detail = notOk
      .sort(([, a], [, b]) => b - a)
      .map(([kind, n]) => {
        const inCycles = byChain.get(chain).cyclesWith[kind].size;
        return `${n} ${kind} across ${inCycles} of ${cycles.length} cycles`;
      })
      .join(", ");
    const rate = ((total - (kinds.ok ?? 0)) / total) * 100;
    console.log(
      `  ${chain.padEnd(24)} ${detail} [${rate.toFixed(1)}% of rows]`,
    );
  }

  if (!anything) {
    const observations = cycles.reduce((sum, { rows }) => sum + rows.length, 0);
    console.log(
      `  Nothing but \`ok\` across all ${observations} observations.`,
    );
  }
}

function reportPublishActivity(cycles) {
  console.log("\n\nPublish activity by hour");
  console.log("=".repeat(72));
  console.log(
    "Venues whose counts moved since the previous cycle, averaged per hour.\n",
  );

  const byHour = new Map();
  let previous = null;

  for (const cycle of cycles) {
    const current = new Map(
      cycle.rows.map((row) => [row.venue, JSON.stringify(row.counts)]),
    );
    if (previous) {
      let changed = 0;
      for (const [venue, counts] of current) {
        if (previous.has(venue) && previous.get(venue) !== counts) changed += 1;
      }
      if (!byHour.has(cycle.hour)) byHour.set(cycle.hour, []);
      byHour.get(cycle.hour).push(changed);
    }
    previous = current;
  }

  if (byHour.size === 0) {
    console.log("  Not enough cycles to compare.");
    return;
  }

  const peak = Math.max(...[...byHour.values()].map((v) => Math.max(...v)));
  for (let hour = 0; hour < 24; hour += 1) {
    const samples = byHour.get(hour);
    if (!samples) continue;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const bar = "#".repeat(peak > 0 ? Math.round((mean / peak) * 40) : 0);
    console.log(
      `  ${String(hour).padStart(2, "0")}:00  ${mean.toFixed(1).padStart(5)} ${bar}`,
    );
  }

  const days = new Set(cycles.map(({ day }) => day)).size;
  if (days < 14) {
    console.log(
      `\n  ${days} day(s) of data - too few to separate weekday patterns from noise.`,
    );
  }
}

function reportHorizon(cycles) {
  console.log("\n\nLatest cycle by chain");
  console.log("=".repeat(72));

  const latest = cycles[cycles.length - 1];
  console.log(
    `Cycle ${latest.cycle}, ${latest.day} ${String(latest.hour).padStart(2, "0")}:00 London.\n`,
  );

  const byChain = new Map();
  for (const row of latest.rows) {
    const chain = chainOf(row.venue);
    if (!byChain.has(chain)) byChain.set(chain, []);
    byChain.get(chain).push(row);
  }

  console.log(
    `  ${"chain".padEnd(24)} ${"venues".padStart(6)} ${"films".padStart(6)} ${"dates".padStart(6)} ${"horizon".padStart(12)}  counts`,
  );
  for (const chain of [...byChain.keys()].sort()) {
    const rows = byChain.get(chain);
    const withCounts = rows.filter(({ counts }) => counts);
    const films = withCounts.reduce((sum, { counts }) => sum + counts.films, 0);
    const dates = withCounts.reduce((sum, { counts }) => sum + counts.dates, 0);

    // How far ahead the chain is selling, as the median venue's furthest date.
    // The max is the wrong statistic here: one venue with a single far-future
    // special event drags it months past anything you could actually book at
    // the rest of the estate.
    const perVenue = rows
      .map(({ byDate }) =>
        Object.keys(byDate ?? {})
          .sort()
          .pop(),
      )
      .filter(Boolean)
      .sort();
    const horizon = perVenue[Math.floor(perVenue.length / 2)];
    const outlier =
      perVenue.length > 0 && perVenue[perVenue.length - 1] !== horizon
        ? perVenue[perVenue.length - 1]
        : null;

    const granularity = rows.find(
      ({ granularity }) => granularity,
    )?.granularity;
    // `in` rather than a `??` default: a mapped `null` means "this chain has
    // no third count", which is not the same as a granularity we don't know.
    const metric =
      granularity in GRANULARITY_METRIC ? GRANULARITY_METRIC[granularity] : "?";
    const counted = metric
      ? `${withCounts.reduce((sum, { counts }) => sum + (counts[metric] ?? 0), 0)} ${metric}`
      : "-";

    console.log(
      `  ${chain.padEnd(24)} ${String(rows.length).padStart(6)} ${String(films).padStart(6)} ${String(dates).padStart(6)} ${(horizon ?? "-").padStart(12)}${outlier ? ` (max ${outlier})` : ""}  ${counted}`,
    );
  }

  console.log(
    "\n  horizon is the median venue's furthest listed date; `max` appears when\n" +
      "  one venue reaches further. films and dates are summed over a chain's\n" +
      "  venues, so a film showing at three of them counts three times - they are\n" +
      "  comparable between chains, but they are not distinct-title counts. The\n" +
      "  last column is not comparable at all: it counts whatever that chain's\n" +
      "  API answers with. A `-` in either of those two columns is a chain that\n" +
      "  reports no per-date breakdown, not one with nothing on - its dates\n" +
      "  column is still its real count of published dates.",
  );
}

async function analyse() {
  const releases = await fetchReleaseList();
  const health = getHealthReleases(releases, NUM_DAYS);

  if (health.length === 0) {
    throw new Error(`No releases in ${REPO} carry a ${ASSET} asset`);
  }

  console.log(`\nReading ${health.length} day(s) of health log...\n`);
  const rows = [];
  for (const release of health) rows.push(...(await fetchDayLog(release)));

  const cycles = toCycles(rows);
  console.log(
    `\n${rows.length} rows across ${cycles.length} cycles, ` +
      `${health[0].tag_name} to ${health[health.length - 1].tag_name}`,
  );

  reportSampling(cycles);
  reportObservations(cycles);
  reportPublishActivity(cycles);
  reportHorizon(cycles);
  console.log("");
}

analyse();
