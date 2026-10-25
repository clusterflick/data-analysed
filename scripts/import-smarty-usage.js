// Folds Smarty's daily usage history into the bandwidth log's seed.
//
// Usage: node scripts/import-smarty-usage.js [--dry-run] <history.json>...
//
// Each file is one page of Smarty's history API, saved by hand:
//
//   curl -H 'Authorization: Bearer <token>' \
//     'https://smarty.co.uk/api/v2/history/data?date_from=2026-10-19&date_to=2026-11-18&page=0' \
//     > smarty-2026-10.json
//
// Run locally, not in a workflow: Smarty's token only lasts a week and comes
// from logging in to the account, so there is nothing for a workflow to hold
// that would still work next month. The router readings are the ongoing
// series; this is what the days before they started - and any gap in them -
// are filled from.
//
// The merged history lives as smarty-usage.json on this repository's
// bandwidth-smarty release, read and written with the `gh` CLI (which needs to
// be logged in with write access here). A day imported again replaces the
// earlier figure, so re-importing a cycle in progress brings its days up to
// date. --dry-run prints the merged file instead of publishing it.
//
// Smarty reports usage as text to two decimal places ("7.21 GB"). Read as
// decimal units, so 1 GB is 10^9 bytes - the figure is within 5 MB either way.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = "clusterflick/data-analysed";
const TAG = "bandwidth-smarty";
const ASSET = "smarty-usage.json";

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

const londonDay = (value) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));

function parseUsage(text) {
  const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(String(text).trim());
  if (!match) throw new Error(`Unrecognised usage figure: ${text}`);
  return Math.round(Number(match[1]) * UNITS[match[2].toUpperCase()]);
}

// A record's `date` is the London midnight that starts its day, given in UTC -
// "2026-10-24T23:00:00.000Z" is 25 Oct in BST - so the day is read back in
// London time rather than sliced off the string.
function readHistory(file) {
  const { data } = JSON.parse(fs.readFileSync(file, "utf8"));
  const attributes = data?.attributes;
  if (!Array.isArray(attributes?.records)) {
    throw new Error(`${file} is not a page of Smarty's usage history`);
  }
  // A full page may not be the last one; a billing cycle is ~31 records
  // against a page size of 50, so this only fires on a long custom range.
  if (attributes.records.length >= attributes.page_size) {
    console.warn(
      `${file} is a full page (page ${attributes.page}) - there may be more; import page ${attributes.page + 1} too`,
    );
  }
  return {
    cycleStart: attributes.date_from,
    days: attributes.records
      .filter((record) => record.type === "data")
      .map((record) => ({
        date: londonDay(record.date),
        bytes: parseUsage(record.usage),
      })),
  };
}

const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// Only a release that is genuinely missing counts as "nothing imported yet".
// Any other failure - not logged in, no network - read that way would publish
// this import alone over everything imported before it.
function releaseExists() {
  try {
    gh("release", "view", TAG, "--repo", REPO, "--json", "tagName");
    return true;
  } catch (error) {
    if (/release not found/i.test(error.stderr ?? "")) return false;
    throw error;
  }
}

function downloadExisting(dir) {
  if (!releaseExists()) return null;
  try {
    gh(
      "release",
      "download",
      TAG,
      "--repo",
      REPO,
      "--pattern",
      ASSET,
      "--dir",
      dir,
    );
  } catch (error) {
    // A release with no asset is only left by a first import that failed to
    // upload; anything else must not be read as "nothing imported yet".
    if (/no assets match/i.test(error.stderr ?? "")) return null;
    throw error;
  }
  return JSON.parse(fs.readFileSync(path.join(dir, ASSET), "utf8"));
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const files = args.filter((arg) => arg !== "--dry-run");
  if (!files.length) {
    throw new Error(
      "Usage: import-smarty-usage.js [--dry-run] <history.json>...",
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smarty-usage-"));
  const existing = downloadExisting(dir) ?? { days: {} };
  const importedAt = new Date().toISOString();
  const today = londonDay(importedAt);

  const days = { ...existing.days };
  let cycleStart = existing.cycleStart;
  let imported = 0;
  for (const file of files) {
    const history = readHistory(file);
    if (!cycleStart || history.cycleStart > cycleStart) {
      cycleStart = history.cycleStart;
    }
    for (const { date, bytes } of history.days) {
      // Today's figure is the day so far. Marked, so the site doesn't read it
      // as a quiet day once the router has a better one.
      days[date] = { bytes, complete: date < today, importedAt };
      imported += 1;
    }
  }

  const merged = {
    // The start of the most recent billing cycle seen. Smarty's cycle runs
    // from this day of the month to the day before it a month later.
    cycleStart,
    updatedAt: importedAt,
    days: Object.fromEntries(
      Object.entries(days).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const output = path.join(dir, ASSET);
  fs.writeFileSync(output, JSON.stringify(merged, null, 2) + "\n");

  const dates = Object.keys(merged.days);
  console.log(
    `${imported} days imported, ${dates.length} held (${dates[0]} to ${dates.at(-1)})`,
  );

  if (dryRun) {
    console.log(fs.readFileSync(output, "utf8"));
    return;
  }

  if (!releaseExists()) {
    gh(
      "release",
      "create",
      TAG,
      "--repo",
      REPO,
      "--latest=false",
      "--title",
      TAG,
      "--notes",
      [
        "Daily data usage from Smarty's account history - the seed for the bandwidth log, and the fallback for any day the router readings don't cover.",
        "Imported by hand with scripts/import-smarty-usage.js.",
        "",
        "⚠️ **Internal telemetry — not licensed.** No rights are granted over it and the shape changes without notice. For data you can use, see https://clusterflick.com/data-licence",
      ].join("\n"),
    );
  }
  // --clobber deletes the old asset before uploading, which rolling-log.sh
  // exists to avoid for the logs a workflow appends to unattended. Fine for a
  // run by hand: the merged file is still on disk if the upload fails.
  console.log(`Merged file: ${output}`);
  gh("release", "upload", TAG, output, "--repo", REPO, "--clobber");
  console.log(`Published ${ASSET} to ${TAG}`);
}

main();
