const { getSourceDiscoverVenues } = require("scripts/sources");
const {
  cinemaNameMatches,
  findMatchingCinema,
  extractPostcode,
} = require("scripts/common/source-utils");
const distanceInKmBetweenCoordinates = require("scripts/common/distance-in-km-between-coordinates");
const { getAllCinemaAttributes } = require("scripts/cinemas");
const {
  getVenueAddress,
  getSampleEventUrl,
  getVenueMatchNames,
  getDiscoverableSourceNames,
} = require("./common/discovered-venues");

// The mirror image of find-venue-name-mismatches.js, which reports venues
// rejected on their name and deliberately skips any whose name did agree.
// Those are the ones this script reports: we already know the venue by that
// name, and only the location check kept it out. Left unreported they show up
// as venues to investigate that we have listed all along.

// Beyond this, a shared name is far more likely to be coincidence than a
// misplaced pin - London has several "The Phoenix" and a "St Mary's Church" in
// most boroughs. Reported anyway, but ranked last and labelled as such.
const COINCIDENCE_DISTANCE_KM = 2;

function describeRejection(cinema, venue) {
  if (!venue.coordinates) return "no coordinates on the venue";
  const distance = distanceInKmBetweenCoordinates(
    cinema.geo,
    venue.coordinates,
  );
  return distance >= 1
    ? `${distance.toFixed(1)}km from the coordinates we hold`
    : `${Math.round(distance * 1000)}m from the coordinates we hold`;
}

function getDistanceKm(cinema, venue) {
  if (!venue.coordinates) return Infinity;
  return distanceInKmBetweenCoordinates(cinema.geo, venue.coordinates);
}

// What would have to change for the matcher to accept this venue. Checked in
// the order they're worth trying: an address the source already gives us is
// free, a wrong stored coordinate is a one-line fix, and anything left needs a
// human to decide whether it's the same place at all.
function suggestFix(cinema, venue, distanceKm) {
  const address = getVenueAddress(venue);

  if (
    address &&
    findMatchingCinema([cinema], venue.name, venue.coordinates, {
      eventAddress: address,
    })
  ) {
    return "passing the address to findMatchingCinema rescues this";
  }

  if (distanceKm > COINCIDENCE_DISTANCE_KM) {
    return "probably a different venue that shares the name";
  }

  const venuePostcode = extractPostcode(address);
  const cinemaPostcode = extractPostcode(cinema.address);
  if (venuePostcode && cinemaPostcode && venuePostcode !== cinemaPostcode) {
    return `postcodes disagree (${venuePostcode} vs ${cinemaPostcode}) - check which is right`;
  }

  return "check the coordinates we hold, or widen maxDistance";
}

function findLocationMismatches(sourceName, venues, knownCinemas) {
  const mismatches = [];

  for (const venue of venues) {
    if (venue.matchingCinema) continue;

    const matchNames = getVenueMatchNames(venue);

    for (const cinema of knownCinemas) {
      // Only interested in the reverse of find-venue-name-mismatches: a cinema
      // we already know under this name, kept out by the location check alone.
      if (!matchNames.some((name) => cinemaNameMatches(cinema, name))) continue;

      const distanceKm = getDistanceKm(cinema, venue);
      mismatches.push({
        venue,
        cinema,
        distanceKm,
        rejection: describeRejection(cinema, venue),
        fix: suggestFix(cinema, venue, distanceKm),
        url: getSampleEventUrl(sourceName, venue),
      });
    }
  }

  // Closest first: a venue just outside the limit is the likeliest real miss,
  // while a name shared across the city is almost always coincidence.
  return mismatches.sort((a, b) => a.distanceKm - b.distanceKm);
}

function reportMismatch({ venue, cinema, distanceKm, rejection, fix, url }) {
  const icon = distanceKm > COINCIDENCE_DISTANCE_KM ? "❓" : "📍";
  console.log(`  ${icon} "${venue.name}" [${venue.events.length} events]`);
  console.log(`     matches ${cinema.id} by name, but is ${rejection}`);
  console.log(`     ${fix}`);
  if (url) console.log(`     ${url}`);
}

function parseOptions(argv) {
  const options = { source: undefined };

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
    options.source = arg;
  }

  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const knownCinemas = getAllCinemaAttributes();
  const sourceNames = getDiscoverableSourceNames(options.source);

  if (sourceNames.length === 0) {
    console.error(
      options.source
        ? `❌ No venue discovery available for "${options.source}"`
        : "❌ No sources with venue discovery found",
    );
    process.exit(1);
  }

  console.log(
    "Venues we already know by name, reported as unknown because the location check rejected them",
  );

  let likelyMisses = 0;
  let coincidences = 0;

  for (const sourceName of sourceNames) {
    console.log(`\n🎬 ${sourceName}`);

    let venues;
    try {
      venues = await getSourceDiscoverVenues(sourceName)();
    } catch (error) {
      console.log(`  ⏭️  Skipped: ${error.message}`);
      continue;
    }

    const mismatches = findLocationMismatches(sourceName, venues, knownCinemas);

    if (mismatches.length === 0) {
      console.log("  ✅ No venues rejected on location alone");
      continue;
    }

    mismatches.forEach(reportMismatch);
    mismatches.forEach(({ distanceKm }) => {
      if (distanceKm > COINCIDENCE_DISTANCE_KM) coincidences += 1;
      else likelyMisses += 1;
    });
  }

  console.log(
    `\nTotal: ${likelyMisses} likely misses, ${coincidences} probably a shared name`,
  );
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
