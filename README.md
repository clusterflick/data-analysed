# Cinema Analysis Scripts

This repository contains scripts for analyzing and validating cinema data for the
Clusterflick project. These scripts help discover new venues, validate cinema IDs,
and check coordinate accuracy.

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

These scripts check that cinema IDs in the database match the IDs used by
cinema chain websites.

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

## Data Files

The `data/` directory contains reference data files:

- `London_GLA_Boundary.geojson` - GeoJSON boundary of Greater London
- `openstreetmap.json` - Cinema data exported from OpenStreetMap
- `mycommunitycinema.json` - Cinema data from MyCommunity Cinema
- `independentcinemaoffice.json` - Cinema data from Independent Cinema Office

## Dependencies

This project uses the [`scripts`](https://github.com/clusterflick/scripts) package
as a dependency. The scripts package provides:

- `scripts/common/utils` - Utility functions (readJSON, fetchText, fetchJson, etc.)
- `scripts/common/geo-utils` - Geographic utilities (isInLondon)
- `scripts/common/cache` - Caching utilities (dailyCache)
- `scripts/common/distance-in-km-between-coordinates` - Geo calculations
- `scripts/common/source-utils` - Source matching utilities
- `scripts/cinemas` - Cinema data access (getAllCinemaNames, getCinemaAttributes, etc.)
- `scripts/sources` - Event source access (getSourceDiscoverVenues, etc.)

## License

MIT
