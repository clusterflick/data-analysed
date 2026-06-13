const { getSourceDiscoverVenues } = require("scripts/sources");

const discoverVenues = getSourceDiscoverVenues("tickettailor.com");

async function main() {
  const venues = await discoverVenues();

  // Don't filter by inLondon: Ticket Tailor events carry no coordinates, but
  // the curated organiser slugs are London film clubs, so surface every venue.
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
