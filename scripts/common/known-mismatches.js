// Titles matching these patterns are sports/live events or private hires we
// deliberately filter out of our data. When an external source (CinemaGuide,
// UKCA) lists them as screenings/performances we don't have, they're expected
// gaps, not real ones. Shared by compare-cinemaguide-screenings.js and
// compare-accessible-screenings.js.
const KNOWN_MISMATCH_PATTERNS = [
  /\s+Cup Screening$/i,
  /\s+League Screening$/i,
  /Union Jack Classic/i,
  /Super Bowl/i,
  /Six Nations/i,
  /AFCON\s+/i,
  /GRAND PRIX:/i,
  /^\w+\s+FANPARK:/i,
  /\bPrivate Hire\b/i,
  /World Cup/i,
  /\bFIFA\b/i,
  /\bEngland\s+vs\b/i,
  /\bvs\.?\s+England\b/i,
];

function isKnownMismatch(title) {
  return KNOWN_MISMATCH_PATTERNS.some((re) => re.test(title));
}

module.exports = { KNOWN_MISMATCH_PATTERNS, isKnownMismatch };
