const slugify = require("slugify");
const { sanitizePathSegment } = require("scripts/common/utils");
const getPageWithPlaywright = require("./common/get-page-with-playwright");
const { isInLondon, getNullMapping, getAttributesFor } = require("./utils");

const prefix = "curzon.com-";
const normalize = (value) => value.replace("Curzon ", "").trim();

const getCinemaId = async ({ url, domain }) => {
  const apiUrl = `https://www.curzon.com/api/omnia/v1/page?friendly=${url.replace(domain, "")}/`;
  const cacheKey = `check-curzon-id${url.replace(domain, "").replace(/\//g, "-")}`;
  const data = await getPageWithPlaywright(url, cacheKey, (page) =>
    page.evaluate(
      async (apiUrl) => fetch(apiUrl).then((r) => r.json()),
      apiUrl,
    ),
  );
  return data.vistaCinema.key;
};

async function checkCurzonIds() {
  const url = "https://www.curzon.com";
  const cacheKey = "check-curzon-ids";
  const venueData = await getPageWithPlaywright(url, cacheKey, async (page) => {
    await page.waitForLoadState();
    // Curzon have moved their API host before, so take it from the page rather
    // than hardcoding it - the same way the retrieval of their listings does.
    const api = await page.evaluate(
      () => /* global window */ window.initialData.api,
    );
    const response = await fetch(`${api.url || api.apiUrl}/ocapi/v1/sites`, {
      headers: {
        Accept: "application/json",
        authorization: `Bearer ${api.authToken}`,
      },
    });
    return response.json();
  });

  const recorded = await getNullMapping(prefix);
  for (let {
    id,
    name: { text: name },
    location: { latitude, longitude },
  } of venueData.sites) {
    name = normalize(name);
    const venue = `${prefix}${sanitizePathSegment(slugify(name))}`;

    if (recorded[venue] === null) {
      const attributes = getAttributesFor(venue);
      recorded[venue] = {
        retrieved: { id, name },
        current: {
          id: await getCinemaId(attributes),
          name: normalize(attributes.name),
        },
      };
    } else if (await isInLondon(latitude, longitude)) {
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
        retrieved.name === current.name &&
        retrieved.id.replace("01", "1") === current.id
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

checkCurzonIds();
