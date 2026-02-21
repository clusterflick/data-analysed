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

module.exports = {
  verifyCineworldListing,
  verifyNickelListing,
  verifyVueListing,
};
