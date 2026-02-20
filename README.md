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
2. **Matches screenings** in three tiers: normalised booking URL, then
   performance ID extracted from URL query parameters, then title similarity
   (Jaccard ≥ 0.3) + time within 15 minutes.
3. **Reports** per-venue differences: screenings in CinemaGuide only (may
   indicate data we're missing) and screenings in our data only (may indicate
   extraneous data or events CinemaGuide doesn't cover).

Each matched venue in the output shows the match method (`url overlap: X%`,
`name-only`, or `hard-coded alias`) so low-confidence matches can be spotted
at a glance.

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
