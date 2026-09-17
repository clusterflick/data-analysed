const { getSourceDiscoverVenues } = require("scripts/sources");
const askLlmToAssessVenue = require("scripts/common/ask-llm-to-assess-venue");
const { getLlmUsageLog } = require("scripts/common/llm-usage-log");
const {
  getVenueAddress,
  getSampleEventUrl,
  getVenueEventTitles,
  getEventOrganiserId,
  getDiscoverableSourceNames,
} = require("./common/discovered-venues");

// Ranks the venues discovery couldn't match against a cinema we already hold,
// so the handful worth researching surface without reading all of them. Run
// find:venue-location-mismatches and find:venue-name-mismatches first: both
// report venues we *do* hold that the matcher missed, and those should be
// fixed rather than ranked as leads.

// A promoter touring one show around town produces the same title at venue
// after venue - a campaign screening in every church hall, a league match in
// every sports bar. None of those venues programme films; they hired out a
// room. Two venues can share a title by coincidence, so only treat it as a
// tour beyond that.
const MAX_VENUES_PER_TOUR = 2;

// Titles vary just enough between stops ("...- Greenwich", "...in Balham")
// that whole-string comparison misses the pattern. The opening words are what
// stays put.
const TOUR_KEY_WORDS = 3;

const DEFAULT_LIMIT = 25;
const DEFAULT_MIN_CONFIDENCE = 6;

// Best lead first. A named strand is what we're hunting for; a venue that
// screens films now and then is still worth a look; a one-off room hire almost
// never is.
const PROGRAMME_RANK = {
  "recurring-programme": 0,
  "occasional-screenings": 1,
  "one-off-booking": 2,
  "not-a-film-venue": 3,
};

function getTourKey(title) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
  return words.length ? words.slice(0, TOUR_KEY_WORDS).join(" ") : null;
}

/**
 * Count how many distinct venues each title and each organiser appears at, so
 * a touring show can be told apart from a venue's own programme.
 */
function buildTourIndex(candidates) {
  const titleVenues = new Map();
  const organiserVenues = new Map();

  const add = (index, key, venueKey) => {
    if (key === null || key === undefined) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(venueKey);
  };

  for (const candidate of candidates) {
    for (const title of candidate.titles) {
      add(titleVenues, getTourKey(title), candidate.key);
    }
    for (const event of candidate.venue.events) {
      add(organiserVenues, getEventOrganiserId(event), candidate.key);
    }
  }

  return { titleVenues, organiserVenues };
}

function isTouring(index, key) {
  const venues = index.get(key);
  return !!venues && venues.size > MAX_VENUES_PER_TOUR;
}

/**
 * Drop the events that belong to a touring show rather than to the venue. A
 * venue left with nothing of its own is not a lead, however many events it
 * listed.
 */
function withoutTouringEvents(candidate, { titleVenues, organiserVenues }) {
  const titles = candidate.titles.filter(
    (title) => !isTouring(titleVenues, getTourKey(title)),
  );
  const isVenueTouredOnly = candidate.venue.events.every((event) =>
    isTouring(organiserVenues, getEventOrganiserId(event)),
  );
  return { ...candidate, titles, isVenueTouredOnly };
}

function collectCandidates(sourceName, venues) {
  return (
    venues
      .filter((venue) => !venue.matchingCinema)
      // `inLondon` is only set by the sources that carry coordinates; where it's
      // absent the source is London-only anyway, so an undefined value passes.
      .filter((venue) => venue.inLondon !== false)
      .map((venue, index) => ({
        // Venue names repeat across London ("Waterstones", "The Phoenix"), so
        // identity has to include where the venue is
        key: `${sourceName}:${venue.name}:${index}`,
        sourceName,
        venue,
        titles: getVenueEventTitles(venue),
        address: getVenueAddress(venue),
        url: getSampleEventUrl(sourceName, venue),
      }))
  );
}

function compareLeads(a, b) {
  const rank =
    PROGRAMME_RANK[a.assessment.programmeType] -
    PROGRAMME_RANK[b.assessment.programmeType];
  if (rank !== 0) return rank;
  if (a.assessment.confidence !== b.assessment.confidence) {
    return b.assessment.confidence - a.assessment.confidence;
  }
  return b.titles.length - a.titles.length;
}

function reportLead({ sourceName, venue, titles, address, url, assessment }) {
  const icon = assessment.programmeType === "recurring-programme" ? "🎯" : "🎬";
  console.log(
    `${icon} ${venue.name} [${titles.length} events] (${sourceName})`,
  );
  console.log(
    `   ${assessment.programmeType}, confidence ${assessment.confidence}${assessment.reason ? ` — ${assessment.reason}` : ""}`,
  );
  if (address) console.log(`   ${address}`);
  titles.slice(0, 3).forEach((title) => console.log(`   · ${title}`));
  if (titles.length > 3) console.log(`   · ... +${titles.length - 3} more`);
  if (url) console.log(`   ${url}`);
  console.log();
}

function parseOptions(argv) {
  const options = {
    source: undefined,
    limit: DEFAULT_LIMIT,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    dryRun: false,
    includeOneOff: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--include-one-off") {
      options.includeOneOff = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = Number(arg.split("=")[1]);
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error(`Invalid limit in "${arg}" - expected a whole number`);
      }
    } else if (arg.startsWith("--min-confidence=")) {
      options.minConfidence = Number(arg.split("=")[1]);
      if (!Number.isFinite(options.minConfidence)) {
        throw new Error(`Invalid confidence in "${arg}" - expected 0-9`);
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    } else {
      options.source = arg;
    }
  }

  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceNames = getDiscoverableSourceNames(options.source);

  if (sourceNames.length === 0) {
    console.error(
      options.source
        ? `❌ No venue discovery available for "${options.source}"`
        : "❌ No sources with venue discovery found",
    );
    process.exit(1);
  }

  let candidates = [];
  for (const sourceName of sourceNames) {
    try {
      const venues = await getSourceDiscoverVenues(sourceName)();
      candidates.push(...collectCandidates(sourceName, venues));
    } catch (error) {
      console.log(`⏭️  ${sourceName} skipped: ${error.message}`);
    }
  }

  const discovered = candidates.length;
  const tourIndex = buildTourIndex(candidates);

  const assessable = candidates
    .map((candidate) => withoutTouringEvents(candidate, tourIndex))
    .filter(({ titles, isVenueTouredOnly }) => {
      if (isVenueTouredOnly) return false;
      return titles.length > 0;
    });

  console.log(
    `${discovered} unmatched venues, ${assessable.length} left to assess after dropping touring shows and untitled listings`,
  );

  if (options.dryRun) {
    console.log(
      `\n--dry-run: no LLM calls made. A full run would assess ${assessable.length} venues.`,
    );
    return;
  }

  const leads = [];
  for (const candidate of assessable) {
    const assessment = await askLlmToAssessVenue({
      name: candidate.venue.name,
      address: candidate.address,
      titles: candidate.titles,
    });
    leads.push({ ...candidate, assessment });
  }

  const usage = getLlmUsageLog();
  const calls = usage.filter(
    ({ cacheKeyPrefix }) => cacheKeyPrefix === "ask-llm-to-assess-venue",
  );
  const cacheHits = calls.filter(({ cacheHit }) => cacheHit).length;

  const worthReporting = leads
    .filter(({ assessment }) => assessment.isFilmVenue)
    .filter(({ assessment }) => assessment.confidence >= options.minConfidence)
    .filter(
      ({ assessment }) =>
        options.includeOneOff || assessment.programmeType !== "one-off-booking",
    )
    .sort(compareLeads);

  console.log(
    `${calls.length} assessed (${cacheHits} from cache), ${worthReporting.length} leads worth a look\n`,
  );

  worthReporting.slice(0, options.limit).forEach(reportLead);

  if (worthReporting.length > options.limit) {
    console.log(
      `... ${worthReporting.length - options.limit} more, raise --limit to see them`,
    );
  }

  const counts = leads.reduce((totals, { assessment }) => {
    totals[assessment.programmeType] =
      (totals[assessment.programmeType] || 0) + 1;
    return totals;
  }, {});
  console.log(
    Object.entries(counts)
      .sort((a, b) => PROGRAMME_RANK[a[0]] - PROGRAMME_RANK[b[0]])
      .map(([type, count]) => `${count} ${type}`)
      .join(", "),
  );
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
