# Anti-SocialCard.de

Static, multilingual overview of initiatives and exchange actions against the Bezahlkarte for refugees.

## Update the site

```bash
npm run update
```

The updater fetches the Seebrücke Bezahlkarte campaign page, merges curated additions and overrides from `data/catalog.yml`, geocodes missing initiative locations with a local cache in `data/geocodes.json`, writes `data/initiatives.json`, vendors Leaflet assets to `assets/leaflet/`, and regenerates `index.html`.

## Curated data

Use `data/catalog.yml` for initiatives missing from the scraper, corrections to scraped entries, and manually checked local public transport links. Keep `id` values stable for curated initiatives.

For exact map locations, add one or more entries with `name`, `address`, optional free-text `openingHours`, and a manually maintained `updatedAt` date under `locations`. The updater geocodes addresses, stores the resulting coordinates in `data/geocodes.json`, and displays every named location on the map. Scraped locations receive the current scrape date automatically. Legacy single `address` and manually supplied `coordinates` remain supported.

UI translations live in `data/i18n/*.json`. All translation files must contain the same keys.

## Location search

The static page includes JavaScript for finding nearby initiatives. Visitors can enter a city or postcode, or use browser location access. Typed locations are resolved through OpenStreetMap Nominatim in the browser; current-location access requires HTTPS or localhost. The Leaflet map is opt-in and loads OpenStreetMap tiles only after activation.

## Regular updates

`.github/workflows/update-site.yml` runs the updater every day at 04:17 UTC and commits changes to generated data, the geocode cache, vendored Leaflet assets, and `index.html`.

## Local preview

The site is a static HTML file, so opening `index.html` in a browser is enough. You can also run a local static server:

```bash
npm run serve
```
