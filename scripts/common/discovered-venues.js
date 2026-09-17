const {
  getAllSourceNames,
  getSourceDiscoverVenues,
  getSourceAttributes,
} = require("scripts/sources");

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

// The names a venue could have been matched under. Eventbrite splits the venue
// name before matching ("BFI Southbank, London" -> "BFI Southbank") while other
// sources match on the whole string, so offer both rather than teaching every
// caller which sources split.
function getVenueMatchNames(venue) {
  const [firstSegment] = (venue.name || "").split(/[,|]/);
  return [...new Set([venue.name, firstSegment.trim()].filter(Boolean))];
}

// Turn a URL's last path segment back into something readable, for the sources
// whose discover-venues keeps only a link per event. Dice prefixes its slugs
// with a short random id ("53pbwy-kino-london-...") which carries no meaning.
function deslugify(url) {
  if (!url) return null;
  const [segment] = url.split(/[?#]/)[0].split("/").filter(Boolean).slice(-1);
  if (!segment || /^\d+$/.test(segment)) return null;
  const words = segment
    .replace(/^[a-z0-9]{5,8}-(?=[a-z])/i, "")
    .replace(/-tickets-\d+$/i, "")
    .split("-")
    .filter(Boolean);
  return words.length > 1 ? words.join(" ") : null;
}

// Each source's discover-venues groups the platform's own event records, so
// the title lives under a different key in each - or under none at all, for
// the sources that keep just a URL. Falling back to the slug keeps every
// source assessable rather than only the three that carry a title field.
function getEventTitle(event) {
  if (!event || typeof event !== "object") return null;
  return (
    event.name || event.title || event.event || deslugify(event.url) || null
  );
}

/**
 * Every event title known for a venue, in listing order.
 * @param {Object} venue - A venue from a source's discoverVenues
 * @returns {string[]} Titles, with anything untitled dropped
 */
function getVenueEventTitles(venue) {
  return (venue.events || []).map(getEventTitle).filter(Boolean);
}

// Only Eventbrite exposes who listed an event. Used to spot a promoter touring
// the same show around town, so an absent id simply means no such evidence.
function getEventOrganiserId(event) {
  return event?.primary_organizer_id ?? null;
}

/**
 * The sources that support venue discovery, optionally narrowed to one.
 * @param {string} [only] - A single source name to restrict the list to
 * @returns {string[]} Source names with a discoverVenues implementation
 */
function getDiscoverableSourceNames(only) {
  return getAllSourceNames().filter((name) => {
    if (only && name !== only) return false;
    return !!getSourceDiscoverVenues(name);
  });
}

module.exports = {
  getVenueAddress,
  getEventTitle,
  getVenueEventTitles,
  getEventOrganiserId,
  getSampleEventUrl,
  getVenueMatchNames,
  getDiscoverableSourceNames,
};
