const { getSourceDiscoverVenues } = require("scripts/sources");

const discoverVenues = getSourceDiscoverVenues("humanitix.com");

async function main() {
  const venues = await discoverVenues();

  // Don't filter by inLondon: Humanitix events carry no coordinates, but the
  // source is queried with a London geobox so every venue is already in London.
  venues.forEach((venue) => {
    const hasMatch = venue.matchingCinema ? "✅" : "❌";
    const matchInfo = venue.matchingCinema
      ? `(${venue.matchingCinema.id})`
      : "";

    const eventUrl = venue.events[0]?.url || "";

    console.log(
      `${hasMatch} ${venue.name} [${venue.events.length} events] ${matchInfo}\n   ${eventUrl}`,
    );
  });

  console.log(`\nTotal: ${venues.length} venues`);
}

main().catch(console.error);
