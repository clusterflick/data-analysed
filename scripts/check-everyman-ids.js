const slugify = require("slugify");
const {
  fetchText,
  fetchJson,
  sanitizePathSegment,
} = require("scripts/common/utils");
const { isInLondon, getNullMapping, getAttributesFor } = require("./utils");

const prefix = "everymancinema.com-";
const normalize = (value) =>
  value
    .replace("Everyman ", "")
    .replace(/^at\s+/i, "")
    .trim();

async function checkEverymanIds() {
  const mainPage = await fetchText("https://www.everymancinema.com/");

  // Extract the CMS hash URL from the main page
  const requestPrefix = mainPage.match(/src="([^"]+)webpack-runtime-/i)[1];
  const pageData = await fetchJson(
    `${requestPrefix}page-data/index/page-data.json`,
  );

  let venueData = null;
  // Run through all page data blobs until we find the ones we want to keep
  for (const hash of pageData.staticQueryHashes) {
    const url = `${requestPrefix}page-data/sq/d/${hash}.json`;
    const data = await fetchJson(url);
    if (data?.data?.allTheater?.nodes?.[0]?.__typename === "Theater") {
      venueData = data.data.allTheater.nodes;
    }
  }

  const recorded = await getNullMapping(prefix);
  const excludedSpecialVenues = [
    // Not an actual cinema - it's a seasonal summer pop-up with a hard coded
    // schedule that we pull from a different source, so exclude it here.
    `${prefix}everyman-on-the-canal-at-kings-cross`,
  ];
  // Exclude special venues, like seasonal popups, which aren't listed on the site.
  for (const venue of excludedSpecialVenues) delete recorded[venue];

  for (let {
    id,
    name,
    practicalInfo: { coordinates },
  } of venueData) {
    name = normalize(name);
    const venue = `${prefix}${sanitizePathSegment(slugify(name))}`;

    if (recorded[venue] === null) {
      const attributes = getAttributesFor(venue);
      recorded[venue] = {
        retrieved: { id, name },
        current: {
          id: attributes.cinemaId,
          name: normalize(attributes.name),
        },
      };
    } else if (await isInLondon(coordinates.latitude, coordinates.longitude)) {
      recorded[venue] = {
        retrieved: { id, name },
        current: {}, // We don't have this one!
      };
    }
  }

  let failForError = false;
  for (const cinema in recorded) {
    process.stdout.write(
      `[🎞️  Location: ${cinema}]${"".padEnd(50 - cinema.length, " ")}`,
    );

    if (!recorded[cinema]) {
      failForError = true;
      console.log(` - ❌ Missing data`);
    } else {
      const { retrieved, current } = recorded[cinema];
      if (retrieved.name === current.name && retrieved.id === current.id) {
        console.log(` - ✅ Matching data`);
      } else {
        failForError = true;
        console.log(` - ❌ Data mismatch`);
      }
    }
  }

  if (failForError) process.exit(1);
}

checkEverymanIds();
