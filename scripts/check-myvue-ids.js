const cheerio = require("cheerio");
const slugify = require("slugify");
const {
  sanitizePathSegment,
  fetchJson,
  fetchText,
} = require("scripts/common/utils");
const { dailyCache } = require("scripts/common/cache");
const { isInLondon, getNullMapping, getAttributesFor } = require("./utils");

const prefix = "myvue.com-";

async function checkMyvueIds() {
  const venueData = (
    await fetchJson("https://www.myvue.com/api/microservice/showings/cinemas")
  ).result.reduce((list, { cinemas }) => list.concat(cinemas), []);

  const coordinates = {};
  for (const { cinemaId: id, whatsOnUrl } of venueData) {
    const whatsOn = await dailyCache(`myvue-${id}`, async () =>
      fetchText(whatsOnUrl),
    );
    const $ = cheerio.load(whatsOn);
    const nextDataScript = $("#__NEXT_DATA__").html();
    if (!nextDataScript) {
      throw new Error(
        `No __NEXT_DATA__ found for cinema ${id} (${whatsOnUrl}). ` +
          `The page structure may have changed.`,
      );
    }
    const nextData = JSON.parse(nextDataScript);
    const coordsValue =
      nextData?.props?.pageProps?.layoutData?.sitecore?.context?.cinema
        ?.cinemaLocationCoordinates?.value;
    if (!coordsValue) {
      throw new Error(
        `No cinemaLocationCoordinates found in __NEXT_DATA__ for cinema ${id} (${whatsOnUrl}). ` +
          `The data structure may have changed.`,
      );
    }
    const match = coordsValue.split(",");
    if (match.length !== 2) {
      throw new Error(
        `Coordinates for cinema ${id} don't match expected format: "${coordsValue}".`,
      );
    }
    const [lat, lon] = match;
    coordinates[id] = { lat: lat.trim(), lon: lon.trim() };
  }

  const recorded = await getNullMapping(prefix);
  for (const { cinemaId: id, fullName } of venueData) {
    const name = fullName
      .replace("London - ", "")
      .replace(" Circus", "")
      .replace(" St Mark's Square", "")
      .replace(" Entertainment Centre", "")
      .replace(" Cook Road", "")
      .replace(" Eltham High Street", "")
      .replace(" St Georges", "")
      .replace(" The Brewery", "")
      .replace(/\s-(?:\s|$)/, " ")
      .replace(/^Vue /i, "")
      .trim();

    const sluggedName = name
      .replace(" (02 Centre)", "")
      .replace(" (not Westfield)", "")
      .replace(" (Finchley Lido)", "")
      .replace(" (Angel Central)", "")
      .replace(" (Shepherd's Bush)", "")
      .replace("West End ", "")
      .trim();
    const venue = `${prefix}${sanitizePathSegment(slugify(sluggedName))}`;

    if (recorded[venue] === null) {
      const attributes = getAttributesFor(venue);
      recorded[venue] = {
        retrieved: { id, name },
        current: {
          id: attributes.cinemaId,
          name: attributes.name.replace("Vue ", "").trim(),
        },
      };
    } else if (await isInLondon(coordinates[id].lat, coordinates[id].lon)) {
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
      if (
        retrieved.name
          .replace("(Shepherd's Bush)", "London")
          .replace(/\([^)]+\)/i, "")
          .replace("Stratford City", "Stratford")
          .trim() === current.name &&
        retrieved.id === current.id
      ) {
        console.log(` - ✅ Matching data`);
      } else {
        failForError = true;
        console.log(` - ❌ Data mismatch`);
      }
    }
  }

  if (failForError) process.exit(1);
}

checkMyvueIds();
