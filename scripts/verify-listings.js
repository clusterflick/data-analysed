const cheerio = require("cheerio");
const { fromZonedTime } = require("date-fns-tz");
const { fetchText } = require("scripts/common/utils");
const { dailyCache } = require("scripts/common/cache");
const getPageWithPlaywright = require("./common/get-page-with-playwright");

// ---------------------------------------------------------------------------
// Cineworld listing verification
// ---------------------------------------------------------------------------

// Check if a Cineworld performance still exists via their API.
// Returns true if valid, false if the listing has been removed.
async function verifyCineworldListing(url) {
  try {
    const u = new URL(url);
    const site = u.searchParams.get("site") || u.searchParams.get("sitecode");
    const sessionId = u.searchParams.get("id");
    if (!site || !sessionId) return true; // can't verify, assume valid

    const apiUrl = `https://experience.cineworld.co.uk/api/OrderMedia?theatreCode=${site}&sessionId=${sessionId}`;
    const res = await fetch(apiUrl);
    if (!res.ok) return false;

    const data = await res.json();
    return !!(data && !data.error);
  } catch {
    return true; // on network error, assume valid
  }
}

// ---------------------------------------------------------------------------
// The Nickel listing verification
// ---------------------------------------------------------------------------

// Check if a Nickel screening still exists via their API.
// Returns true if valid, false if the listing has been removed (404 / error body).
async function verifyNickelListing(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/screening\/(\d+)/);
    if (!m) return true; // can't extract ID, assume valid
    const id = m[1];

    const res = await fetch(`https://thenickel.co.uk/api/screenings/${id}`);
    if (res.status === 404) return false;
    if (!res.ok) return true; // other errors: assume valid

    const data = await res.json();
    return !(data && data.error);
  } catch {
    return true; // on network error, assume valid
  }
}

// ---------------------------------------------------------------------------
// Vue cinema listing verification
// ---------------------------------------------------------------------------

// Check if a Vue showing still exists via their API.
// Returns true if valid, false if the listing has been removed.
// Logs a warning if the request fails for an unexpected reason (e.g. blocked by
// Cloudflare) so those aren't silently counted as stale.
async function verifyVueListing(url) {
  try {
    const cleaned = url.replace(/([^:])\/\/+/g, "$1/");
    const u = new URL(cleaned);
    const m = u.pathname.match(/\/book-tickets\/summary\/(\d+)\/[^/]+\/(\d+)/);
    if (!m) return true; // can't extract IDs, assume valid
    const [, cinemaId, showingId] = m;

    const apiUrl = `https://www.myvue.com/api/microservice/showings/cinemas/${cinemaId}/showings/${showingId}`;
    const result = await getPageWithPlaywright(
      cleaned,
      `vue-verify-${showingId}`,
      async (page) => {
        await page.waitForLoadState();
        return page.evaluate(async (apiUrl) => {
          const res = await fetch(apiUrl, {
            headers: { Accept: "application/json" },
          });
          const data = await res.json().catch(() => null);
          return { status: res.status, data };
        }, apiUrl);
      },
    );

    if (result.status === 400) {
      const msg =
        result.data?.innerErrorMessage || result.data?.errorMessage || "";
      if (msg.toLowerCase().includes("is not found")) return false;
      console.warn(`  [Vue] Unexpected 400 for ${url}: ${msg}`);
    } else if (result.status !== 200) {
      console.warn(`  [Vue] Unexpected ${result.status} for ${url}`);
    }

    return true;
  } catch (err) {
    console.warn(`  [Vue] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Vista VistaWebClient ocapi helper (Curzon + Odeon share the same backend)
// ---------------------------------------------------------------------------

// Navigate to pageUrl in Playwright (establishing session/auth), then call the
// ocapi showtimes endpoint from within the browser context.
// Returns false if the showtime has been removed (404), true otherwise.
async function verifyVistaListing(pageUrl, apiUrl, label) {
  const result = await getPageWithPlaywright(
    pageUrl,
    `${label}-verify-${apiUrl.split("/").pop()}`,
    async (page) => {
      await page.waitForLoadState();
      return page.evaluate(async (apiUrl) => {
        const authToken = window.initialData?.api?.authToken || null;
        const headers = { Accept: "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
        const res = await fetch(apiUrl, { headers });
        return { status: res.status, hasAuth: !!authToken };
      }, apiUrl);
    },
  );
  if (result.status === 404) return false;
  if (result.status !== 200) {
    console.warn(
      `  [${label}] Unexpected ${result.status} for ${pageUrl}${result.hasAuth ? "" : " (no auth token)"}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Curzon listing verification
// ---------------------------------------------------------------------------

// Check if a Curzon showtime still exists via the Vista ocapi.
async function verifyCurzonListing(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/ticketing\/seats\/([^/]+)/);
    if (!m) return true; // can't extract ID, assume valid
    const showtimeId = m[1];
    const apiUrl = `https://vwc.curzon.com/WSVistaWebClient/ocapi/v1/showtimes/${showtimeId}`;
    return verifyVistaListing(url, apiUrl, "Curzon");
  } catch (err) {
    console.warn(`  [Curzon] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Odeon listing verification
// ---------------------------------------------------------------------------

// Check if an Odeon showtime still exists via the Vista ocapi.
async function verifyOdeonListing(url) {
  try {
    const u = new URL(url);
    const showtimeId = u.searchParams.get("showtimeId");
    if (!showtimeId) return true; // can't extract ID, assume valid
    const apiUrl = `https://vwc.odeon.co.uk/WSVistaWebClient/ocapi/v1/showtimes/${showtimeId}`;
    return verifyVistaListing(url, apiUrl, "Odeon");
  } catch (err) {
    console.warn(`  [Odeon] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Everyman Cinema listing verification
// ---------------------------------------------------------------------------

// Check if an Everyman showing still exists via their ticketing API.
// Without session cookies the API returns 500 + nulls for both valid and
// deleted sessions, so we use Playwright to make the call from within a
// browser context that has the necessary cookies established.
async function verifyEverymanListing(url) {
  try {
    // Strip any malformed query params (CG sometimes appends &x-wwm-soldout=1)
    const cleaned = url.replace(/&[^?].*$/, "");
    const u = new URL(cleaned);
    const m = u.pathname.match(/\/launch\/ticketing\/([^/?]+)/);
    if (!m) return true; // can't extract token, assume valid
    const token = m[1];

    const apiUrl = `https://purchase.everymancinema.com/api/launch/ticketing/${token}`;
    const result = await getPageWithPlaywright(
      cleaned,
      `everyman-verify-${token}`,
      async (page) => {
        await page.waitForLoadState();
        return page.evaluate(async (apiUrl) => {
          const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ selectedLanguageCulture: null }),
          });
          return { status: res.status };
        }, apiUrl);
      },
    );

    if (result.status === 200) return true;
    if (result.status === 500) return false;
    console.warn(`  [Everyman] Unexpected ${result.status} for ${url}`);
    return true;
  } catch (err) {
    console.warn(`  [Everyman] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Picturehouses listing verification
// ---------------------------------------------------------------------------

// Check if a Picturehouses showtime still exists via their scheduled-movies API.
// CG links for Picturehouses are film-level (/movie-details/{cinemaId}/{filmCode}/),
// so we fetch all currently-scheduled films at the venue and check whether the
// specific film still has a showtime matching the CG entry's time.
//
// The API returns Showtime as UK local time with no timezone marker; we use
// date-fns-tz to parse it as Europe/London before comparing against our UTC times.
async function verifyPicturehousesListing(url, screening) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/movie-details\/(\d+)\/([^/]+)/);
    if (!m) return true; // can't extract IDs, assume valid
    const [, cinemaId, filmCode] = m;

    const res = await fetch(
      "https://www.picturehouses.com/api/scheduled-movies-ajax",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `cinema_id=${cinemaId}`,
      },
    );
    if (!res.ok) return true; // API error: assume valid

    const data = await res.json();
    if (data.response !== "success") return true;

    const film = (data.movies || []).find(
      (movie) => movie.ScheduledFilmId === filmCode,
    );
    if (!film) return false; // film no longer scheduled at this venue

    const TIME_TOLERANCE_MS = 5 * 60 * 1000;
    return (film.show_times || []).some((st) => {
      // Showtime is UK local time with no TZ marker — parse as Europe/London
      const stMs = fromZonedTime(st.Showtime, "Europe/London").getTime();
      return Math.abs(stMs - screening.timeMs) <= TIME_TOLERANCE_MS;
    });
  } catch (err) {
    console.warn(`  [Picturehouses] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Prince Charles Cinema listing verification
// ---------------------------------------------------------------------------

// Check if a PCC showtime still exists by fetching the booking page.
// A removed showtime returns a page containing "Sorry, the showtime is not available."
async function verifyPrinceCharlesListing(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return true; // unexpected error: assume valid
    const text = await res.text();
    return !text.includes("showtime is not available");
  } catch {
    return true; // on network error, assume valid
  }
}

// ---------------------------------------------------------------------------
// Forest Cinema listing verification
// ---------------------------------------------------------------------------

// Check if a Forest Cinema screening still exists by fetching the event page
// and looking for the date panel + matching performance time.
// The page has `.panel_YYYYMMDD` containers with `a.perfButton` elements
// showing the time (e.g. "15:45").
async function verifyForestCinemaListing(url, screening) {
  try {
    const eventId = new URL(url).pathname.split("/").pop();
    const html = await dailyCache(`forest-event-${eventId}`, () =>
      fetchText(url),
    );
    const $ = cheerio.load(html);

    const d = new Date(screening.timeMs);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const panel = $(`.panel_${yyyy}${mm}${dd}`);
    if (panel.length === 0) return false;

    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const expectedTime = `${hh}:${min}`;

    const times = panel
      .find("a.perfButton")
      .map((_, el) => $(el).text().trim())
      .get();

    return times.includes(expectedTime);
  } catch (err) {
    console.warn(`  [Forest Cinema] Error verifying ${url}: ${err.message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  verifyCineworldListing,
  verifyNickelListing,
  verifyVueListing,
  verifyCurzonListing,
  verifyOdeonListing,
  verifyEverymanListing,
  verifyPicturehousesListing,
  verifyPrinceCharlesListing,
  verifyForestCinemaListing,
};
