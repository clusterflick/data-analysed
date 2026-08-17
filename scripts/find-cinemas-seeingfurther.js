// Data from https://seeingfurther.substack.com/ - a weekly newsletter listing
// self-organised film screenings in London. Each listing is a paragraph of
// "<link to the event> / Venue Name (Area) / date / price", so every post gives
// us both a venue name to check against our cinemas and a link whose host tells
// us whether we have any route to that venue's data at all.
const fs = require("node:fs");
const path = require("node:path");
const cheerio = require("cheerio");
const { decode } = require("html-entities");
const { dailyCache } = require("scripts/common/cache");
const { fetchJson, getText } = require("scripts/common/utils");
const {
  findMatchingCinema,
  cinemaNameMatches,
} = require("scripts/common/source-utils");
const normalizeVenueName = require("scripts/common/normalize-venue-name");
const { getAllCinemaAttributes } = require("scripts/cinemas");
const { getAllSourceNames, getSourceAttributes } = require("scripts/sources");

const PUBLICATION = "https://seeingfurther.substack.com";
const ARCHIVE_PAGE_SIZE = 50;

// ANSI colors, dropped when the report is being piped or redirected so a saved
// copy doesn't carry escape codes through it.
const styled = process.stdout.isTTY && !process.env.NO_COLOR;
const style = (code) => (styled ? code : "");
const c = {
  reset: style("\x1b[0m"),
  bold: style("\x1b[1m"),
  dim: style("\x1b[2m"),
  cyan: style("\x1b[36m"),
};

// Hosts that carry the newsletter itself rather than a screening - Substack's
// own links, the mailto for submissions, and the image CDN.
const IGNORED_HOSTS = [
  "substack.com",
  "substackcdn.com",
  "substackcdn.net",
  "seeingfurther.substack.com",
];

// Venue names that have been looked at and are not a venue we could ever hold -
// add to this as the report is worked through, so each run only shows what is
// still outstanding.
const reviewedVenues = [
  // Canal Film Club screen at a different towpath each time
  "Location released to ticket holders 48hrs before each event",
  "East London Canal",
];

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
// Where the date starts within a segment. A month name on its own is not enough
// to go on - "MayDay Rooms" and "Loughborough Junction" are venues - so a day
// number is required either before the month ("18 April", "17-8 July") or after
// it. Whatever precedes the match is the venue, if anything does.
const DATE = new RegExp(
  `\\b(\\d{1,2}(\\s*[–—-]\\s*\\d{1,2})?\\s*(${MONTHS})|(${MONTHS})\\s+\\d{1,2})\\b`,
  "i",
);
const PRICE = /£|\bfree\b|\bdonation\b|\bpwyc\b|\bsold out\b|\bnhs\b/i;

// Enough of the UK second-level domains to keep "cafeoto.co.uk" whole while
// "organiser.eventive.org" folds down to the platform that hosts it.
const SECOND_LEVEL_DOMAINS = new Set([
  "co",
  "org",
  "ac",
  "gov",
  "net",
  "me",
  "ltd",
  "plc",
  "sch",
]);

// Some sources don't sweep their platform - they retrieve a fixed list of
// organiser pages, hand-maintained in the source's own retrieve.js. Recognising
// the host of one of those platforms therefore says nothing about whether we
// pull the screening: an organiser missing from the list looks exactly like a
// source we already cover, which is the gap this picks out. The lists are read
// from the source rather than copied, so this can't drift away from them.
const ALLOWLIST_SOURCES = {
  "tickettailor.com": {
    id: "tickettailor.com",
    listName: "VENUE_SLUGS",
    // https://www.tickettailor.com/events/<organiser>/<event id>
    getOrganiser: ({ pathname }) => pathname.match(/^\/events\/([^/]+)/)?.[1],
  },
  "ti.to": {
    id: "ti.to",
    listName: "VENUE_SLUGS",
    // https://ti.to/<organiser>/<event>
    getOrganiser: ({ pathname }) => pathname.match(/^\/([^/]+)/)?.[1],
  },
  "thecliq.app": {
    id: "thecliq.app-",
    listName: "CLUB_SLUGS",
    // https://www.thecliq.app/club/<organiser>
    getOrganiser: ({ pathname }) => pathname.match(/^\/club\/([^/]+)/)?.[1],
  },
};

/**
 * The organisers a source retrieves, read out of the array its retrieve.js
 * declares them in. Throws rather than reporting empty coverage if the array
 * can't be found, so a rename in the source shows up as a failure here.
 */
function readAllowlist({ id, listName }) {
  const sourcesPath = path.dirname(require.resolve("scripts/sources"));
  const contents = fs.readFileSync(
    path.join(sourcesPath, id, "retrieve.js"),
    "utf8",
  );
  const declaration = contents.match(
    new RegExp(`const ${listName} = \\[([^\\]]*)\\]`),
  );
  if (!declaration) {
    throw new Error(`No ${listName} found in sources/${id}/retrieve.js`);
  }
  return new Set(
    [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, slug]) => slug),
  );
}

function buildAllowlists() {
  return new Map(
    Object.entries(ALLOWLIST_SOURCES).map(([host, allowlist]) => [
      host,
      { ...allowlist, organisers: readAllowlist(allowlist) },
    ]),
  );
}

/**
 * Ticketing platforms hand every organiser their own subdomain, so grouping
 * unknown hosts by the registrable domain is what tells a platform worth adding
 * as a source apart from a single venue running its own site.
 */
function getRegistrableDomain(host) {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const depth = SECOND_LEVEL_DOMAINS.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-depth).join(".");
}

const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function addToIndex(index, host, entity) {
  if (!index.has(host)) index.set(host, []);
  if (!index.get(host).includes(entity)) index.get(host).push(entity);
}

/**
 * Every host we can reach a source through, mapped to the sources behind it.
 */
function buildSourceHostIndex(sources) {
  const index = new Map();
  for (const source of sources) {
    for (const host of [getHost(source.domain), getHost(source.url)]) {
      if (host) addToIndex(index, host, source);
    }
  }
  return index;
}

/**
 * Cinemas by the hosts they can be recognised from. A venue's `url` is often a
 * third-party booking host, which is worth recognising - but where that host is
 * a platform we treat as a source it belongs to the platform, not to the one
 * venue that happens to book through it, or every Ticket Tailor link in the
 * newsletter would read as Good Shepherd Studios. A host the venue gives as its
 * own domain stays theirs either way, which is how BFI Southbank keeps
 * whatson.bfi.org.uk while BFI Festivals also sells from it.
 */
function buildCinemaHostIndex(cinemas, sourceHosts) {
  const index = new Map();
  for (const cinema of cinemas) {
    const ownHost = getHost(cinema.domain);
    for (const host of [ownHost, getHost(cinema.url)]) {
      if (!host) continue;
      if (host !== ownHost && lookupHost(sourceHosts, host)) continue;
      addToIndex(index, host, cinema);
    }
  }
  return index;
}

/**
 * The name a domain goes by, in front of its public suffix. A platform selling
 * under more than one TLD - eventbrite.com alongside the eventbrite.co.uk our
 * source sweeps, ticketsource.com alongside ticketsource.co.uk - is one
 * platform listing one event, and the name is what they have in common. Short
 * names are left out of this: matching "ti" would pull in anything.
 */
function getDomainLabel(host) {
  const [label] = getRegistrableDomain(host).split(".");
  return label.length >= 4 ? label : null;
}

/**
 * Ticketing platforms sell from subdomains and sibling hosts we don't hold in
 * attributes - events.humanitix.com against the humanitix.com we know about -
 * so a host counts as ours when it is, sits under, or is the same platform as
 * one we hold.
 */
function lookupHost(index, host) {
  if (index.has(host)) return index.get(host);
  for (const [known, entities] of index) {
    if (host.endsWith(`.${known}`)) return entities;
  }

  const label = getDomainLabel(host);
  if (!label) return undefined;
  for (const [known, entities] of index) {
    if (getDomainLabel(known) === label) return entities;
  }
  return undefined;
}

async function getArchive() {
  const posts = [];
  for (let offset = 0; ; offset += ARCHIVE_PAGE_SIZE) {
    const page = await dailyCache(`seeingfurther-archive-${offset}`, () =>
      fetchJson(
        `${PUBLICATION}/api/v1/archive?sort=new&offset=${offset}&limit=${ARCHIVE_PAGE_SIZE}`,
      ),
    );
    posts.push(...page);
    if (page.length < ARCHIVE_PAGE_SIZE) return posts;
  }
}

async function getPostBody(id) {
  const { post } = await dailyCache(`seeingfurther-post-${id}`, () =>
    fetchJson(`${PUBLICATION}/api/v1/posts/by-id/${id}`),
  );
  return post.body_html;
}

/**
 * The venue sits between the linked title and the date. A listing on a venue's
 * own site often omits it entirely - "<link> / 21 August, 8.30pm / 15.50£" -
 * so segments that hold only a date or a price are skipped rather than taken as
 * a name, and a paragraph can legitimately name no venue at all.
 */
function extractVenueName(paragraphText, linkText) {
  const linkEnd = paragraphText.lastIndexOf(linkText);
  const remainder =
    linkEnd === -1
      ? paragraphText
      : paragraphText.slice(linkEnd + linkText.length);

  const segment = remainder
    // The separator is a spaced slash, which is what keeps a venue with a slash
    // in its name - not/nowhere in Homerton - from being split in half.
    .split(/\s+\/\s+/)
    // The separator before the date is sometimes missing, leaving "Rich Mix
    // (Shoreditch) 18 April, 2pm" as one segment, so cut at the date rather
    // than discarding the segment for containing one.
    // A separator written flush against the link ("</a>/ The Castle Cinema")
    // leaves its slash on the front of the segment.
    .map((part) => part.split(DATE)[0].replace(/^[\s/]+|[\s/]+$/g, ""))
    // Punctuation stranded outside the link - "House of the Dead (2003</a>)"
    // leaves a ")" of its own - is not a name.
    .find((part) => /[a-z]/i.test(part) && !PRICE.test(part));
  if (!segment) return null;

  // Listings suffix the venue with the area it's in - "Genesis Cinema
  // (Bethnal Green)" - which isn't part of the name we hold.
  return segment.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

/** The host a link points at, or null if it isn't one a screening lives on */
function getListingHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Posts sign off with a mailto: for submissions, which is not a listing
  if (!/^https?:$/.test(parsed.protocol)) return null;

  const host = parsed.hostname.replace(/^www\./, "");
  // Listings are hand-written, and a mistyped link ("https://wwhttps://...")
  // still parses - into a hostname with no dot in it, which is no host at all.
  if (!host.includes(".")) return null;

  const isIgnored = IGNORED_HOSTS.some(
    (ignored) => host === ignored || host.endsWith(`.${ignored}`),
  );
  return isIgnored ? null : host;
}

function extractListings(post, bodyHtml) {
  const $ = cheerio.load(bodyHtml);

  return $("p")
    .map((i, element) => {
      const links = $(element).find("a");
      if (links.length === 0) return null;

      const paragraphText = decode(getText($(element)));
      const title = decode(getText(links.first()));
      // Posts carry the odd announcement alongside the listings - a festival's
      // call for entries, the address to submit screenings to - which link out
      // mid-sentence rather than leading with the linked title a listing has.
      if (!title || !paragraphText.startsWith(title)) return null;

      // A double bill is listed as one entry with a link per film, and the
      // venue name follows the last of them.
      const venueName = extractVenueName(
        paragraphText,
        decode(getText(links.last())),
      );

      // Where a listing offers more than one way to book - a double bill split
      // across the venue's own site and a ticketing platform - any of them is a
      // route to the screening, so all are checked against what we know. The
      // first is the one the report quotes back.
      const booking = links
        .map((index, link) => $(link).attr("href"))
        .get()
        .map((url) => ({ url, host: getListingHost(url) }))
        .filter(({ host }) => host !== null);
      if (booking.length === 0) return null;

      return { post, title, venueName, booking };
    })
    .get()
    .filter(Boolean);
}

/**
 * What a single booking link gets us: the cinemas that sit on its host, the
 * source that covers it, and - where that source only retrieves a fixed list of
 * organisers - the organiser this link belongs to when it isn't on that list.
 */
function classifyLink({ url, host }, { cinemaHosts, sourceHosts, allowlists }) {
  const cinemas = lookupHost(cinemaHosts, host);
  const source = lookupHost(sourceHosts, host);
  if (!source) return { cinemas, source: undefined };

  const allowlist = allowlists.get(getRegistrableDomain(host));
  if (!allowlist) return { cinemas, source };

  const organiser = allowlist.getOrganiser(new URL(url));
  if (organiser && allowlist.organisers.has(organiser)) {
    return { cinemas, source };
  }
  // The platform is one we retrieve from, but not this corner of it
  return {
    cinemas,
    source: undefined,
    uncovered: { source: source[0], organiser: organiser ?? url, host },
  };
}

function classifyListing(listing, index) {
  const links = listing.booking.map((link) => classifyLink(link, index));
  const cinemaByHost = links.map(({ cinemas }) => cinemas).find(Boolean);
  const cinemaByName = listing.venueName
    ? findMatchingCinema(index.cinemas, listing.venueName, null)
    : undefined;
  const source = links.map(({ source }) => source).find(Boolean);

  // Holding a host is not the same as sweeping it. Sands Films books through
  // eventive.org and three venues we hold list nothing but an Instagram page,
  // so a link on one of those hosts naming a different venue is somebody else's
  // event on a platform we only ever reach one corner of. A listing that names
  // no venue is the venue's own link, and stands.
  const hostCoversVenue =
    !cinemaByHost ||
    !listing.venueName ||
    cinemaByHost.some((held) => cinemaNameMatches(held, listing.venueName));

  // A single host can front a chain, and the listing names which branch, so
  // prefer the name match and fall back to the host when it is unambiguous and
  // is actually this venue's.
  const unambiguousHostCinema =
    hostCoversVenue && cinemaByHost?.length === 1 ? cinemaByHost[0] : undefined;
  const cinema = cinemaByName || unambiguousHostCinema;

  // Knowing the venue and being able to reach the link are separate gaps: we
  // hold plenty of venues whose one-off hires are only ever sold through a
  // platform we don't scrape.
  return {
    ...listing,
    cinema,
    source,
    url: listing.booking[0].url,
    host: listing.booking[0].host,
    hasKnownHost: (!!cinemaByHost && hostCoversVenue) || !!source,
    // Only worth chasing when nothing else already reaches the screening
    uncovered:
      cinemaByHost || source
        ? undefined
        : links.map(({ uncovered }) => uncovered).find(Boolean),
  };
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

const uniqueSorted = (values) => [...new Set(values)].sort();

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const WIDTH = Math.min(process.stdout.columns || 100, 100);
const LABEL_WIDTH = 9;

/**
 * Listings are pasted out of social posts, so the links drag a tail of tracking
 * parameters longer than the terminal is wide. None of it identifies the event.
 */
const TRACKING_PARAM = /^(utm_|fbclid|aff$|_gl$|_ga|igsh$|gclid$|mc_|ref$)/i;
function tidyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/**
 * A labelled value, wrapped to the terminal and hanging under its own label so
 * a long list of venue names stays readable as one field.
 */
function field(label, value) {
  // An unlabelled field is a paragraph, and hangs against the indent instead
  const width = label === "" ? 0 : LABEL_WIDTH;
  const indent = 4 + width;
  const lines = [];
  let line = "";
  for (const word of String(value).split(" ")) {
    if (line && `${line} ${word}`.length + indent > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines.map(
    (text, i) =>
      `    ${c.dim}${(i === 0 ? label : "").padEnd(width)}${c.reset}${text}`,
  );
}

function heading(title, subtitle) {
  const rule = "─".repeat(Math.max(0, WIDTH - title.length - 3));
  return [
    "",
    `${c.bold}${c.cyan}${title}${c.reset} ${c.dim}${rule}${c.reset}`,
    `${c.dim}${subtitle}${c.reset}`,
    "",
  ];
}

/** Every entry closes with a blank line, so runs of them collapse to one */
function joinLines(lines) {
  return lines
    .filter((line, i) => line !== "" || lines[i - 1] !== "")
    .join("\n");
}

/** The headline for one grouped entry: what it is, then how much of it */
function entry(name, meta) {
  return `  ${c.bold}${name}${c.reset}  ${c.dim}${meta}${c.reset}`;
}

function reportUnknownHosts(listings) {
  // A platform we retrieve from but don't have this organiser on is a gap in
  // the source's list rather than a platform we've never seen, and is reported
  // as one by reportUncoveredOrganisers.
  const unknown = listings.filter(
    ({ hasKnownHost, uncovered }) => !hasKnownHost && !uncovered,
  );
  const groups = groupBy(unknown, ({ host }) => getRegistrableDomain(host));
  const lines = heading(
    "Sources we have no route to",
    `${pluralize(unknown.length, "listing")} across ${pluralize(groups.length, "domain")} — candidates for a new source`,
  );
  if (groups.length === 0) return [...lines, `  ${c.dim}None${c.reset}`];

  for (const [domain, group] of groups) {
    const venues = uniqueSorted(
      group.map(({ venueName }) => venueName).filter(Boolean),
    );
    const hosts = uniqueSorted(group.map(({ host }) => host));
    // A domain fronting several venues or handing each one its own subdomain is
    // a ticketing platform worth adding as a source; a domain fronting a single
    // venue is that venue running its own site.
    const shape =
      venues.length > 1 || hosts.length > 1
        ? "possible platform/source"
        : "possible venue site";
    const held = group.filter(({ cinema }) => cinema).length;
    lines.push(
      entry(
        domain,
        `${pluralize(group.length, "listing")} · ${shape} · ${held} held, ${group.length - held} not`,
      ),
    );
    if (venues.length > 0) lines.push(...field("venues", venues.join(", ")));
    if (hosts.length > 1) lines.push(...field("hosts", hosts.join(", ")));
    lines.push(...field("example", tidyUrl(group[0].url)), "");
  }
  return lines;
}

function reportUncoveredOrganisers(listings) {
  const uncovered = listings.filter(({ uncovered }) => uncovered);
  const lines = heading(
    "Organisers missing from a source's list",
    `${pluralize(uncovered.length, "listing")} — each is a slug to add to that source's retrieve.js`,
  );
  if (uncovered.length === 0) return [...lines, `  ${c.dim}None${c.reset}`];

  for (const [, group] of groupBy(
    uncovered,
    ({ uncovered }) => `${uncovered.source.id}/${uncovered.organiser}`,
  )) {
    const { source, organiser } = group[0].uncovered;
    const venues = uniqueSorted(
      group.map(({ venueName }) => venueName).filter(Boolean),
    );
    const meta = `${source.name} · ${pluralize(group.length, "listing")}`;
    lines.push(entry(organiser, meta));
    if (venues.length > 0) lines.push(...field("venues", venues.join(", ")));
    lines.push(...field("example", tidyUrl(group[0].url)), "");
  }
  return lines;
}

function reportUnknownVenues(listings) {
  const reviewed = new Set(reviewedVenues.map(normalizeVenueName));
  const unknown = listings.filter(
    ({ cinema, venueName }) =>
      !cinema && venueName && !reviewed.has(normalizeVenueName(venueName)),
  );
  const groups = groupBy(unknown, ({ venueName }) =>
    normalizeVenueName(venueName),
  );
  const lines = heading(
    "Venues we don't know",
    `${pluralize(groups.length, "venue")} — candidates for a new cinema`,
  );
  if (groups.length === 0) return [...lines, `  ${c.dim}None${c.reset}`];

  for (const [, group] of groups) {
    const names = uniqueSorted(group.map(({ venueName }) => venueName));
    const sources = uniqueSorted(
      group.map(({ source }) => source && source[0].name).filter(Boolean),
    );
    const route =
      sources.length > 0
        ? `reachable via ${sources.join(", ")}`
        : "no known source";
    const meta = `${pluralize(group.length, "listing")} · ${route}`;
    lines.push(entry(names.join(" / "), meta));
    lines.push(
      ...field("hosts", uniqueSorted(group.map(({ host }) => host)).join(", ")),
    );
    const posts = uniqueSorted(group.map(({ post }) => post.slug));
    lines.push(...field("seen in", posts.slice(0, 3).join(", ")));
    lines.push(...field("example", tidyUrl(group[0].url)), "");
  }
  return lines;
}

function reportKnown(listings) {
  const known = listings.filter(({ cinema }) => cinema);
  const groups = groupBy(known, ({ cinema }) => cinema.name);
  const lines = heading(
    "Venues we already know",
    `${pluralize(groups.length, "venue")}, ${pluralize(known.length, "listing")} — a coverage check, nothing to do here`,
  );
  // One line per venue would bury the sections above it, so this is the
  // roll-call rather than a list to work through.
  const names = groups.map(([name, group]) => `${name} (${group.length})`);
  return [...lines, ...field("", names.join(", "))];
}

async function findCinemasSeeingFurther() {
  const postLimit = Number(process.argv[2]) || Infinity;
  const cinemas = getAllCinemaAttributes();
  const sources = getAllSourceNames().map((name) => getSourceAttributes(name));
  const sourceHosts = buildSourceHostIndex(sources);
  const index = {
    cinemas,
    sourceHosts,
    cinemaHosts: buildCinemaHostIndex(cinemas, sourceHosts),
    allowlists: buildAllowlists(),
  };

  const archive = (await getArchive()).slice(0, postLimit);
  const listings = [];
  for (const post of archive) {
    const bodyHtml = await getPostBody(post.id);
    if (!bodyHtml) {
      console.warn(`No body for post "${post.slug}"`);
      continue;
    }
    listings.push(
      ...extractListings(post, bodyHtml).map((listing) =>
        classifyListing(listing, index),
      ),
    );
  }

  const dates = archive.map(({ post_date: postDate }) => postDate.slice(0, 10));
  const knownCount = listings.filter(({ cinema }) => cinema).length;
  const viaSourceCount = listings.filter(
    ({ cinema, source }) => !cinema && source,
  ).length;
  const strandedCount = listings.length - knownCount - viaSourceCount;
  // Right-aligned so the three figures read as a column against each other
  const tally = (count, text) =>
    `  ${c.bold}${String(count).padStart(5)}${c.reset}  ${text}`;

  console.log(
    joinLines([
      "",
      `${c.bold}${c.cyan}Seeing Further listings report${c.reset}`,
      `${c.dim}${archive.length} posts, ${dates[dates.length - 1]} to ${dates[0]} · ${pluralize(listings.length, "listing")}${c.reset}`,
      "",
      tally(knownCount, "at venues we hold"),
      tally(viaSourceCount, "at venues we don't hold, on a source we scrape"),
      tally(strandedCount, "at venues we don't hold, with no route in"),
      ...reportUnknownHosts(listings),
      ...reportUncoveredOrganisers(listings),
      ...reportUnknownVenues(listings),
      ...reportKnown(listings),
      "",
    ]),
  );
}

findCinemasSeeingFurther();
