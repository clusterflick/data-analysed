# Cinema Analysis Scripts

This repository contains scripts for analyzing and validating cinema data for
the Clusterflick project. These scripts help discover new venues, validate
cinema IDs, and check coordinate accuracy.

## Setup

Install dependencies:

```bash
npm install
```

This will install the `scripts` package from GitHub along with other required
dependencies.

## Environment Variables

Some scripts require environment variables. Copy the example file and fill in
your values:

```bash
cp .env.example .env
```

Then edit `.env` with your API keys:

```env
MAPS_API_KEY=your_google_maps_api_key
```

## Available Scripts

### ID Validation Scripts

These scripts check that cinema IDs in the database match the IDs used by cinema
chain websites.

```bash
npm run check:cineworld-ids      # Validate Cineworld cinema IDs
npm run check:curzon-ids         # Validate Curzon cinema IDs
npm run check:everyman-ids       # Validate Everyman cinema IDs
npm run check:myvue-ids          # Validate MyVue cinema IDs
npm run check:odeon-ids          # Validate Odeon cinema IDs
npm run check:omniplex-ids       # Validate Omniplex cinema IDs
npm run check:picturehouse-ids   # Validate Picturehouse cinema IDs
```

### Coordinate Validation

```bash
npm run check:coordinates        # Validate cinema coordinates using Google Maps API
```

Requires `MAPS_API_KEY` environment variable.

### Venue Discovery Scripts

These scripts discover new venues from event platforms that may need to be added
to the cinema database.

```bash
npm run discover:designmynight   # Discover venues from DesignMyNight
npm run discover:dice            # Discover venues from Dice.fm
npm run discover:eventbrite      # Discover venues from Eventbrite
npm run discover:outsavvy        # Discover venues from Outsavvy
npm run discover:ticketsource    # Discover venues from TicketSource
```

### Venue Name Mismatches

Venue matching needs both the name and the location to agree, so a venue we
already know about is dropped whenever a platform lists it under a name we
don't hold. This script runs every source's venue discovery and reports the
venues that were rejected on name alone — they sit at a known cinema, but none
of that cinema's names match:

```bash
npm run find:venue-name-mismatches                    # All sources
npm run find:venue-name-mismatches -- eventbrite.co.uk  # One source
```

Each result is labelled with the fix it points at: `🔤` where the two names
overlap once normalised (a trailing screen number, a parenthetical, a borough
suffix), which `scripts/common/normalize-venue-name.js` could absorb, and `➕`
where the names are unrelated and the venue needs an entry in the cinema's
`alternativeNames`.

Options:

- `--max-distance=<km>` — how close a venue must be to count as the same place
  (default `0.05`). The matcher itself allows `0.35`, but that only holds up
  once a name has agreed: reversed, it puts every central London venue next to
  a dozen cinemas.
- `--include-postcode-area` — also report venues sharing only an outward code
  (`E11`) with a cinema. A district is not a building, so these need checking
  by hand.

Reads `retrieved-data/`, which is populated by
`./scripts/get-latest-retrieved-data.sh`.

### Cinema Discovery Scripts

These scripts find potential new cinemas from external data sources.

```bash
npm run find:openstreetmap           # Find cinemas from OpenStreetMap data
npm run find:mycommunitycinema       # Find cinemas from MyCommunity Cinema
npm run find:independentcinemaoffice # Find cinemas from Independent Cinema Office
npm run find:pearl-and-dean          # Find cinemas from Pearl & Dean
```

### Map Generation

```bash
npm run generate:map             # Generate a KML map file of all cinemas
```

### Release Comparison

```bash
npm run compare:releases -- <current-dir> <previous-dir> <current-tag> <previous-tag>
```

Compares two transformed data releases to identify changes between pipeline
runs.

### Accessible Screenings Comparison

Compares our transformed accessibility data against
[Accessible Screenings UK](https://accessiblescreeningsuk.co.uk/) (UKCA) to
identify gaps in our accessibility tagging.

```bash
npm run download:accessible-screenings   # Fetch UKCA data (extracts JWT tokens from their website)
npm run compare:accessible-screenings -- <ukca-data-path> <transformed-data-dir>
```

The comparison:

1. **Matches venues** by coordinates (within 250m) then name similarity, using a
   greedy best-match algorithm.
2. **Matches performances** in three tiers: normalised booking URL, then
   performance ID extracted from URL query parameters (e.g. `id`, `perfcode`,
   `showtimeId`), then falls back to title similarity (Jaccard ≥ 0.3) + time
   (within 15 minutes). The time fallback is guarded so that two performances
   with different explicit IDs are never cross-matched.
3. **Compares accessibility tags** on matched performances, mapping UKCA tags
   (`AudioDescription`, `AutismFriendly`, `DementiaFriendly`, `Subtitled`,
   `ClosedCaption`, `OpenCaption`) to our fields (`audioDescription`, `relaxed`,
   `subtitled`, `hardOfHearing`, `babyFriendly`).
4. **Reports** mismatches, UKCA-only performances with accessibility tags, and
   venues with no gaps. Outputs a JSON log to `output/`.

#### UKCA data quality carve-outs

UKCA's data has some known inaccuracies that would otherwise produce false
positives. The comparison rolls these up as informational notes rather than real
mismatches:

- **Cineworld screen-level audio description**: UKCA propagates
  `AUDIO_DESCRIPTION` from screen capabilities to all showtimes on that screen,
  even when AD isn't active for a specific showing. Performances where the only
  mismatch is missing `audioDescription` and the screen is listed as AD-capable
  in UKCA's own theater data are treated as info.
- **Cineworld stale audio description**: UKCA sometimes retains
  `AudioDescription` tags on Cineworld performances after Cineworld has removed
  them (e.g. when a film moves to a different screen). The comparison verifies
  AD-only mismatches against Cineworld's showtimes API — if Cineworld confirms
  the performance does not have `audio-described`, the mismatch is treated as
  stale UKCA data. Verification is capped at 25 per venue to avoid excessive API
  calls; if exceeded, mismatches are kept unverified with a warning. If the API
  is unreachable (e.g. Cloudflare blocking the runner IP), the mismatches are
  also kept with a warning.
- **Cineworld stale listings**: UKCA-only accessible performances for Cineworld
  are verified against Cineworld's order API to check if the session still
  exists. Stale listings (removed from Cineworld but still in UKCA) are filtered
  out and reported as info.
- **Vue 10am baby-friendly vs autism-friendly**: Vue's 10am "Mini Mornings"
  screenings are baby-friendly. UKCA categorises these as `AutismFriendly`
  (mapping to `relaxed`). The comparison detects Vue 10am showings where the
  only relevant mismatch is `AutismFriendly → relaxed` and rolls them up as
  info.
- **Extra tags we have that UKCA lacks**: Where our data has accessibility flags
  that UKCA doesn't track (e.g. `babyFriendly`), these are separated from real
  mismatches since they represent us being more detailed, not a gap.

#### Automation

The comparison runs automatically after each transform via
`.github/workflows/compare-accessible-screenings.yml`, triggered by
`repository_dispatch` (`compare_releases`) or manually via `workflow_dispatch`.
The JSON report is uploaded as a GitHub Actions artifact (retained 14 days).

### CinemaGuide Screenings Comparison

Compares our transformed screening data against
[CinemaGuide](https://cinemaguide.co.uk/) to identify differences in coverage
and screentimes.

```bash
npm run download:cinemaguide-screenings
npm run compare:cinemaguide-screenings -- cinemaguide-data/cinemaguide-data.json transformed-data/current/
```

The download fetches all London venues from the CinemaGuide API and saves the
result to `cinemaguide-data/cinemaguide-data.json`.

The comparison:

1. **Matches venues** using URL overlap as the primary signal, falling back to
   name similarity (threshold: 0.8) for venues without bookable links. For
   chains where URL formats differ between CinemaGuide and our data, a
   venue-level key is extracted from the URL instead of comparing full URLs:
   - **Picturehouse**: site code from `/movie-details/{code}/` or
     `/showtimes/{code}-`
   - **Vue**: venue ID from `/book-tickets/summary/{id}/` (CinemaGuide's URLs
     also have a spurious double-slash which is normalised out)
   - One hard-coded alias handles "Electric Cinema Notting Hill" →
     `electriccinema.co.uk-portobello`, where CinemaGuide uses the neighbourhood
     name and we use the street name.
2. **Matches screenings** in six tiers (each only runs on unmatched entries):
   1. Normalised booking URL exact match
   2. Performance ID extracted from URL query parameters (`id`, `perfcode`,
      `showtimeId`, `eid`)
   3. Normalised showing URL + time within 15 minutes (for venues like Barbican
      where CinemaGuide links to the event page rather than a booking system)
   4. Normalised showing URL + BST-adjusted time within 15 minutes — Barbican
      only (see carve-outs below)
   5. URL slug tokens vs title tokens, Jaccard ≥ 0.5 + time within 15 minutes
      (for venues like BFI where CinemaGuide uses clean slug URLs whose words
      match our title words reordered)
   6. Title similarity, Jaccard ≥ 0.3 + time within 15 minutes (last resort;
      prevented from cross-matching entries with conflicting explicit perf IDs)
3. **Reports** per-venue differences: screenings in CinemaGuide only (possible
   gaps in our data) and screenings in our data only (events CinemaGuide doesn't
   cover, not treated as failures).

Each matched venue in the output shows the match method (`url overlap: X%`,
`name-only`, or `hard-coded alias`) so low-confidence matches can be spotted at
a glance.

#### CinemaGuide data quality carve-outs

CinemaGuide's data has some known inaccuracies and structural quirks that would
otherwise produce false positives:

- **Known mismatches — sports and live events**: We deliberately exclude sports
  screenings (e.g. football, rugby, Grand Prix) and FANPARK events. When
  CinemaGuide lists these, they appear as "Expected gaps" in the report rather
  than real failures. Patterns matched: cup/league screenings, Union Jack
  Classic, Super Bowl, Six Nations, AFCON, Grand Prix, FANPARK.
- **Garden Cinema parser artifacts**: CinemaGuide's parser sometimes fails to
  read the date for Garden Cinema screenings and defaults to January 1st while
  keeping the time. Any CG-only Garden Cinema entry dated January 1st is treated
  as a parser artifact and folded into "Expected gaps".
- **CinemaGuide duplicate entries**: CinemaGuide sometimes lists the same
  TicketSource event under multiple venue slugs — once under the programme title
  and once under the individual film title. Entries with identical `link` +
  `time` per venue are deduplicated before matching.
- **Stale listing verification**: For certain venues, CG-only screenings are
  verified against the venue's own API to check whether they've been removed.
  Stale listings (removed from the venue but still in CG) are reported as
  informational rather than failures. Verification is capped at 25 per venue; if
  exceeded, entries are kept unverified with a warning.
  - **Cineworld**: verified via `experience.cineworld.co.uk/api/OrderMedia`
  - **The Nickel**: verified via `thenickel.co.uk/api/screenings/{id}`
  - **Vue**: verified via
    `myvue.com/api/microservice/showings/cinemas/{id}/showings/{showingId}`
    using Playwright (to avoid 401s from direct fetch calls)
  - **Everyman**: verified via
    `purchase.everymancinema.com/api/launch/ticketing/{uuid}` using Playwright
    (session cookies required; 200 = valid, 500 = stale). CG occasionally
    appends `&x-wwm-soldout=1` to the UUID with no leading `?`; this is stripped
    before matching and verification.
  - **Picturehouses**: CG links are film-level
    (`/movie-details/{cinemaId}/{filmCode}/`), so verification POSTs to
    `picturehouses.com/api/scheduled-movies-ajax` with `cinema_id` to retrieve
    all scheduled films at the venue, then checks whether the film is still
    listed and whether any of its showtimes match the CG entry's time (within 5
    minutes, parsed as Europe/London local time).
  - **Curzon**: verified via
    `vwc.curzon.com/WSVistaWebClient/ocapi/v1/showtimes/{id}` using Playwright
    (404 = stale).
  - **Odeon**: verified via
    `vwc.odeon.co.uk/WSVistaWebClient/ocapi/v1/showtimes/{id}` using Playwright
    (404 = stale).
- **Barbican BST time offset**: Barbican's website has incorrect `datetime`
  attributes during British Summer Time — they write the local time as if it
  were UTC (e.g. `18:30:00Z` for an event that is actually 18:30 BST = 17:30
  UTC). CinemaGuide trusts this attribute; our pipeline reads the display text
  and stores the correct UTC time. For Barbican events during BST, CG times are
  therefore 1 hour ahead of ours. The comparison accounts for this by adding a
  dedicated matching tier that shifts CG's time back by 1 hour for BST-period
  Barbican events before checking URL + time.

### Cinemour Screenings Comparison

Compares our transformed screening data against
[Cinemour](https://www.cinemour.com/) to identify films it lists as being in
London cinemas that we have no future screening for.

```bash
npm run download:cinemour-screenings
npm run compare:cinemour-screenings -- cinemour-data/cinemour-data.json transformed-data/current/
```

The download fetches Cinemour's `/api/in-cinemas` endpoint and saves the
result to `cinemour-data/cinemour-data.json`.

Unlike CinemaGuide, Cinemour's endpoint isn't a per-venue screening feed — it
returns TMDB-backed film lists (`openingThisWeek`, `nowShowing`, `comingSoon`,
`laterThisYear`) used to drive its own homepage, with no venue or showtime
attached. So the comparison works at the film level rather than the
screening level:

1. **Builds the target set**: the union of `openingThisWeek` and `nowShowing`
   — the films Cinemour currently considers bookable. `comingSoon` and
   `laterThisYear` are excluded since we wouldn't expect screenings for them
   yet.
2. **Indexes our data** by TMDB id: every showing across every venue with at
   least one future performance contributes its `themoviedb.id` (single
   match) and/or `themoviedbs[].id` (multiple-movies match, e.g. double
   bills) to the index.
3. **Reports** target films whose TMDB id isn't in our index — i.e. Cinemour
   thinks it's in cinemas but we have no future screening for it anywhere.

Missing films are split into two severities:

- **Opening this week** — a brand new release Cinemour lists that we're
  missing entirely. High-confidence signal; forces the badge red and the
  script to exit non-zero.
- **Now showing only** — Cinemour's `nowShowing` list is dominated by
  repertory/rep-cinema re-releases (season programming, one-off classics),
  so some genuine noise is expected here (a title playing at a venue Cinemour
  tracks that we don't, or vice versa). Still reported, but treated as a
  lower-confidence, informational signal (orange badge) rather than a hard
  failure driver — though the script still exits non-zero on any miss so CI
  surfaces the count.

## Data Files

The `data/` directory contains reference data files:

- `London_GLA_Boundary.geojson` - GeoJSON boundary of Greater London
- `openstreetmap.json` - Cinema data exported from OpenStreetMap
- `mycommunitycinema.json` - Cinema data from MyCommunity Cinema
- `independentcinemaoffice.json` - Cinema data from Independent Cinema Office

## Dependencies

This project uses the [`scripts`](https://github.com/clusterflick/scripts)
package as a dependency. The scripts package provides:

- `scripts/common/utils` - Utility functions (readJSON, fetchText, fetchJson,
  etc.)
- `scripts/common/geo-utils` - Geographic utilities (isInLondon)
- `scripts/common/cache` - Caching utilities (dailyCache)
- `scripts/common/distance-in-km-between-coordinates` - Geo calculations
- `scripts/common/source-utils` - Source matching utilities
- `scripts/cinemas` - Cinema data access (getAllCinemaNames,
  getCinemaAttributes, etc.)
- `scripts/sources` - Event source access (getSourceDiscoverVenues, etc.)

## License

MIT
