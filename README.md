# Anti-SocialCard.de

Static, multilingual overview of initiatives and exchange actions against the Bezahlkarte for refugees.

## Update the site

```bash
npm run update
```

The updater fetches the Seebrücke Bezahlkarte campaign page, merges curated additions and overrides from `data/catalog.yml`, geocodes missing initiative locations with a local cache in `data/geocodes.json`, writes `data/initiatives.json`, vendors Leaflet assets to `assets/leaflet/`, and regenerates `index.html`.

## Curated data

Use `data/catalog.yml` for initiatives missing from the scraper, corrections to scraped entries, and manually checked local public transport links. Keep `id` values stable for curated initiatives.

If a curated initiative has the same `city`, `region`, and `country` as a scraped initiative, it automatically replaces the scraped entry. The generated `seebruecke-...` ID is not needed in the catalog.

For exact map locations, add one or more entries with `name`, `address`, optional `notes`, and `openingSlots` under `locations`. General `notes` are also supported at initiative level. Keep manually maintained notes in `data/catalog.yml` in English.

```yaml
notes: "Bring the payment card and a valid receipt."
openingSlots:
  - weekdays: [3]
    start: "17:00"
    end: "19:00"
    notes: "Only for FLINTA people."
```

Curated initiatives maintain one `updatedAt` date at initiative level; scraped initiatives receive the current scrape date automatically. The updater geocodes addresses, stores the resulting coordinates in `data/geocodes.json`, and displays every named location on the map. Legacy single `address` and manually supplied `coordinates` remain supported.

Opening hours are generated from `openingSlots` for both display and route planning. Weekdays use ISO values `1` (Monday) through `7` (Sunday); `weeksOfMonth` and per-slot `notes` are optional. Times must use 24-hour `HH:MM` format. The website formats weekdays for the selected UI language and displays times in both 24-hour and 12-hour formats.

```yaml
openingSlots:
  - weekdays: [1]
    weeksOfMonth: [1, 3]
    start: "17:00"
    end: "19:00"
```

UI translations live in `data/i18n/*.json`. All translation files must contain the same keys.

## Location search

The static page includes JavaScript for finding nearby initiatives. Visitors can enter a city or postcode, or use browser location access. The same Cloudflare Worker that serves the website proxies and caches manually triggered OpenStreetMap Nominatim searches under `/geocode`; current-location access requires HTTPS or localhost. The Leaflet map is opt-in and loads OpenStreetMap tiles only after activation.

Public transport time is used as an approximate city-to-city sorting value. It selects the shortest representative rail connection between the central stations, falling back to other public transport where necessary, and measures from the first transit departure to the last transit arrival. Initial waiting time, local walking, and urban access legs are excluded. Place and postcode searches use the central station for detailed Transitous links; complete street addresses and browser geolocation remain exact. Each concrete initiative location has its own Transitous link for detailed door-to-door planning.

## Regular updates

`.github/workflows/update-site.yml` runs the updater every day at 04:17 UTC and commits changes to generated data, the geocode cache, vendored Leaflet assets, and `index.html`.

## Local preview

To preview the complete Cloudflare Worker, including location search:

```bash
npm run dev
```

Wrangler prints the local URL after the build has completed. `npm run serve` remains available for a static preview without the geocoding proxy.

## Cloudflare deployment

The Worker named `tauschaktionen-finder` serves both the generated site and the geocoding proxy. Log in once and then deploy:

```bash
npx wrangler login
npm run deploy
```

`npm run deploy` regenerates the site, prepares only the public files in `dist/`, and updates the existing `tauschaktionen-finder.peter161.workers.dev` Worker. No separate Worker or dashboard upload is required.
