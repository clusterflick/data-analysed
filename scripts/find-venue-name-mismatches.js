const {
  getAllSourceNames,
  getSourceDiscoverVenues,
  getSourceAttributes,
} = require("scripts/sources");
const {
  findCinemasMatchingLocation,
  cinemaNameMatches,
} = require("scripts/common/source-utils");
const normalizeVenueName = require("scripts/common/normalize-venue-name");
const { getAllCinemaAttributes } = require("scripts/cinemas");

// The matcher tolerates 350m between a venue and a cinema, which is safe when
// the name has already agreed but useless on its own: in central London every
// venue sits within 350m of a dozen cinemas. Reversing the check to hunt for
// name mismatches needs a radius that means "the same building", so default
// far tighter and let --max-distance widen it back out when triaging a
// specific venue.
const DEFAULT_MAX_DISTANCE_KM = 0.05;

// Sources name the venue address differently: most carry it as `address`,
// while TicketSource joins its separate address fields into `eventAddress`.
function getVenueAddress(venue) {
  return venue.address || venue.eventAddress || null;
}

// Mirrors the sample URL each discover-*-venues.js script prints, since the
// grouped events are the source's own raw records rather than a shared shape.
function getSampleEventUrl(sourceName, venue) {
  const event = venue.events[0];
  if (!event) return "";
  if (sourceName === "designmynight.com") return event.path || "";
  if (sourceName === "ticketsource.co.uk") {
    const { domain } = getSourceAttributes(sourceName);
    return `${domain}/whats-on/${event.locationSlug}/${event.venueSlug}/${event.eventSlug}/${event.eventHash}`;
  }
  return event.url || "";
}

function describeLocationMatch(locationMatch) {
  if (locationMatch.type === "distance") {
    return `${Math.round(locationMatch.distance * 1000)}m away`;
  }
  if (locationMatch.type === "postcode") {
    return `same postcode (${locationMatch.postcode})`;
  }
  return `same postcode district (${locationMatch.postcode.split(/\s+/)[0]})`;
}

// Strongest evidence first: a measured distance beats a postcode, which beats
// a whole postcode district.
function compareEvidence(a, b) {
  const rank = { distance: 0, postcode: 1, "postcode-area": 2 };
  const rankDifference =
    rank[a.locationMatch.type] - rank[b.locationMatch.type];
  if (rankDifference !== 0) return rankDifference;
  if (a.locationMatch.type !== "distance") return 0;
  return a.locationMatch.distance - b.locationMatch.distance;
}

// The two fixes these near-misses point at. Normalisation can only close a gap
// where one name already sits inside the other once normalised (a trailing
// screen/room, a borough suffix, a "presented by" wrapper); anything else is a
// name we simply don't know about and needs listing on the cinema.
function suggestFix(venueName, cinema) {
  const normalizedVenue = normalizeVenueName(venueName);
  const names = (cinema.alternativeNames || []).concat(cinema.name);
  const overlaps = names.some((name) => {
    const normalizedCinema = normalizeVenueName(name);
    return (
      normalizedCinema.length > 0 &&
      (normalizedVenue.includes(normalizedCinema) ||
        normalizedCinema.includes(normalizedVenue))
    );
  });
  return overlaps ? "normalisation" : "additional name";
}

function findNearMisses(sourceName, venues, knownCinemas, options) {
  const nearMisses = [];

  for (const venue of venues) {
    if (venue.matchingCinema) continue;

    // Deliberately not passing supportMisconfiguredCoordinates: a venue over
    // 5000km from a cinema is only tolerated by the matcher because the name
    // already agreed, so as location evidence on its own it means nothing.
    // Those venues can still match here on their address postcode.
    const candidates = findCinemasMatchingLocation(
      knownCinemas,
      venue.coordinates,
      {
        maxDistance: options.maxDistance,
        eventAddress: getVenueAddress(venue),
      },
    );

    for (const { cinema, locationMatch } of candidates) {
      // A cinema whose name does agree was rejected on location, not on name
      if (cinemaNameMatches(cinema, venue.name)) continue;
      if (
        locationMatch.type === "postcode-area" &&
        !options.includePostcodeArea
      ) {
        continue;
      }

      nearMisses.push({
        venue,
        cinema,
        locationMatch,
        fix: suggestFix(venue.name, cinema),
        url: getSampleEventUrl(sourceName, venue),
      });
    }
  }

  return nearMisses.sort(compareEvidence);
}

function reportNearMiss({ venue, cinema, locationMatch, fix, url }) {
  const names = (cinema.alternativeNames || []).concat(cinema.name);
  const icon = fix === "normalisation" ? "🔤" : "➕";

  console.log(`  ${icon} "${venue.name}" [${venue.events.length} events]`);
  console.log(
    `     ${cinema.id} — ${describeLocationMatch(locationMatch)}, known as ${names.map((name) => `"${name}"`).join(", ")}`,
  );
  console.log(
    `     normalised: "${normalizeVenueName(venue.name)}" vs "${normalizeVenueName(cinema.name)}" — needs ${fix}`,
  );
  if (url) console.log(`     ${url}`);
}

function parseOptions(argv) {
  const options = {
    source: undefined,
    maxDistance: DEFAULT_MAX_DISTANCE_KM,
    includePostcodeArea: false,
  };

  for (const arg of argv) {
    if (arg === "--include-postcode-area") {
      options.includePostcodeArea = true;
    } else if (arg.startsWith("--max-distance=")) {
      options.maxDistance = Number(arg.split("=")[1]);
      if (!Number.isFinite(options.maxDistance)) {
        throw new Error(`Invalid distance in "${arg}" - expected km`);
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
  const knownCinemas = getAllCinemaAttributes();

  const sourceNames = getAllSourceNames().filter((name) => {
    if (options.source && name !== options.source) return false;
    return !!getSourceDiscoverVenues(name);
  });

  if (sourceNames.length === 0) {
    console.error(
      options.source
        ? `❌ No venue discovery available for "${options.source}"`
        : "❌ No sources with venue discovery found",
    );
    process.exit(1);
  }

  console.log(
    `Venues rejected on name alone, within ${Math.round(options.maxDistance * 1000)}m or sharing a postcode with a known cinema`,
  );

  const totals = { normalisation: 0, "additional name": 0 };

  for (const sourceName of sourceNames) {
    console.log(`\n🎬 ${sourceName}`);

    let venues;
    try {
      venues = await getSourceDiscoverVenues(sourceName)();
    } catch (error) {
      console.log(`  ⏭️  Skipped: ${error.message}`);
      continue;
    }

    const nearMisses = findNearMisses(
      sourceName,
      venues,
      knownCinemas,
      options,
    );
    const unmatched = venues.filter((venue) => !venue.matchingCinema).length;

    if (nearMisses.length === 0) {
      console.log(
        `  ✅ No name mismatches (${unmatched} unmatched venues, none at a known cinema)`,
      );
      continue;
    }

    nearMisses.forEach(reportNearMiss);
    nearMisses.forEach(({ fix }) => (totals[fix] += 1));

    // One venue can sit at more than one known cinema, so count the venues
    // rather than the suggestions when reporting coverage
    const venuesAtKnownCinema = new Set(nearMisses.map(({ venue }) => venue))
      .size;
    console.log(
      `  ${venuesAtKnownCinema} of ${unmatched} unmatched venues are at a known cinema`,
    );
  }

  console.log(
    `\nTotal: ${totals["additional name"]} suggested additional names, ${totals.normalisation} that normalisation could cover`,
  );
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
