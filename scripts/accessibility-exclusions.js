// ---------------------------------------------------------------------------
// Manual accessibility exclusions
// ---------------------------------------------------------------------------
//
// Cases we've manually reviewed and concluded UKCA is wrong (e.g. it tagged a
// whole film's run as Audio Described when only some performances were, or none
// at all on the venue's own site). Matching mismatches are downgraded to
// informational — they're stripped from the actionable set so they no longer
// fail the run — but still counted so they stay visible.
//
// Each entry:
//   venueId  (required) — our venue file name, e.g. "barbican.org.uk"
//   perfIds  (required) — performance IDs as they appear in the booking URL
//                         (the trailing path segment or an id/perfcode/etc.
//                         query param — same extraction the matcher uses).
//   fields   (optional) — accessibility fields to excuse (e.g.
//                         ["audioDescription"]). Omit to excuse every
//                         "missing-in-ours" field for that performance.
//   reason   (required) — why UKCA is believed wrong + when reviewed. This is
//                         documentation for the next person; keep it specific.
//
// Exclusions are pinned to exact performance IDs on purpose: when the run
// extends, new performances of the same film re-appear as fresh mismatches and
// the script fails again — that's deliberate, so a genuinely-missing tag in our
// own data still surfaces rather than being masked by a broad film-level rule.
//
// These should be transient: revisit when the offending performances drop off
// UKCA's feed and delete stale entries so this list doesn't rot.

module.exports = [
  {
    venueId: "barbican.org.uk",
    perfIds: ["3615401", "3615601", "3615801"],
    fields: ["audioDescription"],
    reason:
      "Backrooms: Everything Must Go Edition — no AD tag on the Barbican site " +
      "for these performances; UKCA appears to have applied AudioDescription " +
      "across the whole film's run. Reviewed 2026-07-05.",
  },
  {
    venueId: "thecastlecinema.com",
    // The Invite. — all upcoming showtimes except the genuine HOH-subtitles
    // screening (Mon 6 Jul 16:00, id 17124, which we already carry correctly).
    perfIds: [
      "17086",
      "17114",
      "17123",
      "17125",
      "17128",
      "17129",
      "17130",
      "17135",
      "17137",
      "17138",
      "17139",
      "17140",
      "17146",
      "17147",
      "17148",
    ],
    fields: ["subtitled"],
    reason:
      "The Invite. — UKCA tags every one of the film's ~21 showtimes Subtitled " +
      "(matching the film-level AD/subtitle badges), but the Castle site marks " +
      "only the one HOH-subtitles screening (Mon 6 Jul 16:00, id 17124) as " +
      "captioned, which we already carry. Reviewed 2026-07-05.",
  },
];
