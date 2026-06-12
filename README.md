# Anti-SocialCard.de

Static, multilingual overview of initiatives and exchange actions against the Bezahlkarte for refugees.

## Update the site

```bash
npm run update
```

The updater fetches the Seebrücke Bezahlkarte campaign page, merges self-managed group files from Nextcloud, geocodes missing initiative and event locations with `data/geocodes.json`, writes `data/initiatives.json`, vendors Leaflet assets to `assets/leaflet/`, and regenerates `index.html`.

Every updater run writes a timestamped Markdown report to the ignored local `logs/` directory. In GitHub Actions, the complete report is published in the public job summary instead of being committed. Reports list failed initiative websites, website status transitions, warnings, and initiative-level changes compared with the previous `data/initiatives.json`. Volatile check and update timestamps are excluded from the content comparison.

## Self-managed group data

Each managed initiative edits one Markdown file in a central Nextcloud folder. The filename without `.md` is its stable technical ID. The preferred configuration is a read-only public folder share:

- `NEXTCLOUD_SHARE_URL`: the complete browser share link, for example `https://cloud.example/s/ShareToken`
- `NEXTCLOUD_SHARE_PASSWORD`: optional password for a password-protected share

The updater derives the public WebDAV endpoint from that link. As a fallback, account WebDAV remains supported through `NEXTCLOUD_URL`, `NEXTCLOUD_USERNAME`, `NEXTCLOUD_APP_PASSWORD`, and `NEXTCLOUD_FOLDER`.

For local updates, copy `.env.example` to `.env` and set the real share URL there. `npm run update` loads `.env` automatically. The file is ignored by Git. A missing configuration or unreachable share fails the update clearly; cached group data is used only when `ALLOW_GROUP_CACHE_FALLBACK=true` is set deliberately.

Upload-ready files migrated from the former catalog are available in `examples/group-data/`. Their filenames are the existing stable initiative IDs and should not be changed.

`data/group-cache.json` stores only the last valid normalized version, ETags, and check metadata. If Nextcloud is unavailable or a file is missing or invalid, the last valid entry remains published. No credentials, share links, or raw files are stored.

```markdown
# Gruppendaten

## Initiative

| Feld | Wert |
| --- | --- |
| Status | aktiv |
| Name | Anti-SocialCard Kiel |
| Ort | Kiel |
| Bundesland / Region | Schleswig-Holstein |
| Land | Deutschland |
| Webseite | https://example.org/ |

## Tauschorte

| Name | Adresse | Wochentage | Wochen im Monat | Von | Bis | Ortshinweise | Terminhinweise |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Stadtteilladen | Kieler Str. 12, 24143 Kiel | Mittwoch | jede | 17:00 | 19:00 | Eingang im Hinterhof | |

## Einzeltermine

| Titel | Datum | Von | Bis | Ort | Adresse | Hinweise |
| --- | --- | --- | --- | --- | --- | --- |
| Zusätzlicher Tauschtermin | 18.07.2026 | 15:00 | 18:00 | Stadtteilladen | Kieler Str. 12, 24143 Kiel | Bitte Bezahlkarte mitbringen |

## Weitere Hinweise

Weitere Hinweise der Initiative stehen hier.
```

Set the status to `ausgeblendet` to suppress the managed entry; all other rows and sections may then be omitted. Active group data replaces a scraped initiative with the same city, region, and country. Future one-off events are shown chronologically and included in map and route calculations; past events are filtered at publication time.

Weekdays are written out in German and separated with commas, for example `Montag, Mittwoch`. Use `jede` for a weekly appointment or numbers such as `1, 3` for the first and third week of a month. Dates use `TT.MM.JJJJ`; times use `HH:MM`. The text under `Weitere Hinweise` is sanitized and displayed as plaintext.

UI translations live in `data/i18n/*.json`. All translation files must contain the same keys.

## Location search

The static page includes JavaScript for finding nearby initiatives. Visitors can enter a city or postcode, or use browser location access. The same Cloudflare Worker that serves the website proxies and caches manually triggered OpenStreetMap Nominatim searches under `/geocode`. A singleton Durable Object spaces cache misses at least one second apart before forwarding them to Nominatim. Current-location access requires HTTPS or localhost. The Leaflet map is opt-in and loads OpenStreetMap tiles only after activation.

Public transport time is used as an approximate city-to-city sorting value. It selects the shortest representative rail connection between the central stations, falling back to other public transport where necessary, and measures from the first transit departure to the last transit arrival. Initial waiting time, local walking, and urban access legs are excluded. Place and postcode searches use the central station for detailed Transitous links; complete street addresses and browser geolocation remain exact. Each concrete initiative location has its own Transitous link for detailed door-to-door planning.

## Regular updates

`.github/workflows/update-site.yml` runs tests and the updater every day at 04:17 UTC, writes a compact job summary, and commits generated data, caches, reports, vendored Leaflet assets, and `index.html`.

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
