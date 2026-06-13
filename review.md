# Codebase Review

Reviewed on 2026-06-13 at commit `84599db`.

## Findings

### High: stale Transitous requests can undo privacy controls and corrupt results [Resolved 2026-06-13]

**References:** `scripts/update-site.mjs:1780`, `scripts/update-site.mjs:2103`, `scripts/update-site.mjs:2113`, `scripts/update-site.mjs:2118`, `scripts/update-site.mjs:2174`

**Resolution:** Routing generations now own an `AbortController`. Enabling or disabling transit and changing origin aborts the previous generation, clears in-flight station lookups, and prevents stale requests from updating route state or writing local storage. Transitous station and route fetches receive the generation signal. Regression coverage in `test/generated-routing.test.mjs` checks both the generator template and committed page.

`disableTransit()` increments `routingGeneration`, clears the route cache, and marks routes disabled. A worker that has already passed the generation check can still finish afterward. It then writes its result to local storage inside `fetchCityTravelTime()`, calls `setCityRouteState()` against the current `rankedNearest` list, and renders again.

The same race occurs when the visitor chooses a different origin. A response calculated for the old origin can be applied to initiatives for the new origin because route state is keyed only by destination city.

Consequences:

- Disabling transit can repopulate the cache immediately after it was cleared.
- A transit result can remain visible after the visitor disabled the feature.
- Results from a previous origin can be shown for a newly selected origin.
- Requests that the UI treats as cancelled continue to affect current state.

Capture the generation for every request and check it again after every awaited operation, before cache writes, before state updates, and before rendering. Prefer an `AbortController` per routing generation and pass its signal to all Transitous fetches. Cache writes should happen only after confirming that transit is still enabled and the generation is current.

### High: externally supplied URLs are trusted in both browser and server contexts [Resolved 2026-06-13]

**References:** `scripts/update-site.mjs:230`, `scripts/update-site.mjs:269`, `scripts/update-site.mjs:321`, `scripts/update-site.mjs:364`, `scripts/update-site.mjs:431`, `scripts/update-site.mjs:501`, `scripts/update-site.mjs:1818`, `scripts/update-site.mjs:2688`, `scripts/group-data.mjs:530`

**Resolution:** `scripts/url-security.mjs` now provides the shared URL boundary for scraped, managed, source, and transit links. Only credential-free HTTP(S) URLs are accepted. Website checks resolve every hostname, reject private and reserved IPv4 targets and non-global or reserved IPv6 targets, pin an approved address into the actual HTTP(S) request to prevent DNS rebinding, and manually revalidate every redirect. Tests cover unsafe schemes, credentials, local and reserved networks, mixed DNS answers, address pinning, private redirect targets, managed group URLs, updater integration, and all links embedded in the committed page.

Scraped links are accepted by `new URL()` without restricting the protocol. `javascript:` and other non-HTTP URLs therefore pass validation and are emitted into clickable `href` attributes. Escaping HTML characters does not make an unsafe URL scheme safe.

Managed group websites are restricted to HTTP(S), but the updater later fetches every non-social website and follows redirects. A group editor can point a website at loopback, private-network, link-local, or cloud metadata addresses. Redirects can reach the same destinations. This creates an SSRF path whenever the updater runs on a developer machine or CI runner.

Use one URL validator for all initiative, source, and transit links:

- Permit only `https:` and, if genuinely necessary, `http:`.
- Reject credentials in URLs.
- Before server-side link checks, resolve hostnames and reject loopback, private, link-local, multicast, and other non-public address ranges for IPv4 and IPv6.
- Revalidate every redirect target, which may require manual redirect handling.
- Keep browser display validation separate from the stricter rules required for server-side fetching.

The committed dataset currently contains only HTTP(S) URLs, so this is an input-boundary vulnerability rather than evidence of current malicious data.

### Medium: CI validates the old generated script, then commits a newly generated one

**References:** `.github/workflows/update-site.yml:19`, `.github/workflows/update-site.yml:20`, `.github/workflows/update-site.yml:21`, `package.json:9`, `scripts/check-generated-script.mjs:4`

The workflow runs `npm test` before `npm run update`. The generated-script check therefore parses the previously committed `index.html`. The updater can generate invalid browser JavaScript afterward, and the workflow will still commit it.

Run the generated-script check after `npm run update`, or make the build command:

1. generate the site;
2. validate generated HTML and JavaScript;
3. prepare deployment output.

The post-generation phase should also verify that embedded JSON parses and that `data/initiatives.json` matches the data embedded in `index.html`.

### Medium: one-off events linked to locations are rendered twice

**References:** `scripts/update-site.mjs:1825`, `scripts/update-site.mjs:1829`, `scripts/update-site.mjs:1868`

`renderLocationDetails()` renders every event whose `locationName` matches the location. `renderCard()` then renders the complete event list again at card level. Every matched event consequently appears once under its location and once after all locations.

The current committed dataset has zero events, so this is not visible today. It will affect the documented `Einzeltermine` feature as soon as a future event is published.

Render unmatched events at card level:

```js
const unmatchedEvents = item.events.filter((event) => !matchesAnyLocation(event, item.locations));
```

Add a generated-page or browser test covering matched and unmatched events.

### Medium: the public geocoding proxy has no admission or backlog controls

**References:** `worker/index.js:24`, `worker/index.js:52`, `worker/index.js:73`, `worker/index.js:100`, `worker/index.js:116`

The Worker accepts arbitrary public search terms and serializes cache misses through one global Durable Object. An attacker can create many unique queries, building a long queue at one request per second. Legitimate visitors then wait behind that backlog, and the Worker continues consuming requests after clients time out.

The upstream rate limit protects Nominatim, but it does not protect this service from queue exhaustion or cost amplification.

Add bounded admission controls, such as per-client rate limiting, a maximum queue depth, and early rejection with `429 Retry-After`. Consider normalizing cache keys and restricting search to the parameters the UI actually sends. Record metrics for cache hits, queue delay, upstream calls, and rejected requests.

### Medium: upstream fetches can stall the scheduled update for a long time

**References:** `scripts/update-site.mjs:153`, `scripts/update-site.mjs:757`, `scripts/update-site.mjs:818`, `scripts/group-data.mjs:354`, `scripts/group-data.mjs:389`

Website checks have a ten-second timeout, but the source-page fetch, Nominatim build geocoding, Nextcloud `PROPFIND`, and Nextcloud file downloads have no timeout. A server that accepts a connection and stops responding can hold the update until the platform-level job timeout.

Apply explicit timeouts to every network boundary. Use operation-specific limits and include the operation and URL host in errors. Retry only transient failures, with a small bounded backoff.

### Medium: source scraping is not scoped tightly enough to detect structural drift

**References:** `scripts/update-site.mjs:203`, `scripts/update-site.mjs:204`, `scripts/update-site.mjs:217`, `scripts/update-site.mjs:223`, `scripts/update-site.mjs:228`, `scripts/update-site.mjs:111`

The scraper scans every `h2` through `h4` in the entire source document and carries country and region state forward. Unrelated headings can be interpreted as initiatives. The only drift guard is a minimum count of 20, so a structurally wrong parse that still finds enough headings can be published.

Use an HTML parser and first select the campaign list container. Validate stronger invariants:

- recognized countries and regions;
- plausible initiative URLs and names;
- no unexpected heading transitions;
- bounded changes in counts and IDs compared with the previous dataset.

Large removals, additions, or region migrations should fail the automated update or require explicit approval.

### Low: reverse geocoding accepts omitted coordinates as zero

**References:** `worker/index.js:150`, `worker/index.js:151`

`URLSearchParams.get()` returns `null` for a missing parameter, and `Number(null)` is `0`. Requests such as `/geocode/reverse` therefore pass validation with an implicit latitude or longitude of zero.

Check parameter presence and non-empty strings before numeric conversion. Validate `zoom` as an integer in Nominatim's supported range as well.

### Low: translation validation checks keys but not usable values

**References:** `scripts/update-site.mjs:167`, `scripts/update-site.mjs:173`

The updater enforces key parity, which is useful, but it does not validate value types, empty strings, ordinal-array lengths, or required interpolation placeholders. A translation can pass validation and still break recurrence formatting or produce blank controls.

Define a small schema from `de.json`: strings must remain non-empty strings, ordinal arrays must contain five strings, and templates must retain required placeholders such as `{weekday}` and `{ordinals}`.

### Low: operational documentation contradicts the workflow

**References:** `README.md:13`, `README.md:75`, `.github/workflows/update-site.yml:33`

The README first says reports are ignored locally and published in the job summary, then says the workflow commits reports. The workflow file pattern does not commit `logs/`, and `logs/` is ignored.

Update the regular-updates section to state that the job summary is published but timestamped reports are not committed.

## Test And Quality Assessment

The group-data parser has focused tests for normalization, invalid input, cache fallback, ETag behavior, hidden groups, and missing files. Translation files currently have identical 81-key shapes and matching value categories. The committed HTML embeds 110 initiatives and ten languages, and its inline browser script parses successfully.

The largest coverage gap is the generated client application. There are no behavioral tests for:

- changing origin while transit requests are in flight;
- disabling transit during a request;
- event placement and duplicate rendering;
- local-storage failure and cache expiry;
- location suggestion selection;
- language switching and RTL behavior;
- map activation and Leaflet load failures;
- malformed geocoder or Transitous responses.

The Worker also has no direct tests for request validation, cache behavior, headers, timeout handling, or queueing. Extracting its request validation and URL construction into dependency-injected functions would make Node tests straightforward. Durable Object behavior can then be covered with Wrangler's test tooling.

`node --test` currently reports two top-level test files rather than a granular suite in its summary, even though `group-data.test.mjs` contains many subtests. This is not a correctness problem, but more explicit test-reporter output in CI would make failures easier to locate.

## Architecture Notes

Strong aspects:

- Generated artifacts have a clear source pipeline.
- Group cache entries store normalized data rather than credentials or raw files.
- Managed text is escaped at browser HTML sinks.
- Translation key parity is enforced during updates.
- Website checks use bounded concurrency and a timeout.
- Leaflet is vendored and map tiles are opt-in.
- Transit requests require an explicit preference.
- The updater produces useful change and failure reports.

Maintainability risks:

- `scripts/update-site.mjs` combines scraping, normalization, validation, network checks, report generation, a full CSS document, HTML, and roughly 1,200 lines of browser code. Small changes have a wide review surface and most functions cannot be imported without executing the updater.
- Browser code exists only inside a template literal, so linting, unit testing, and editor tooling are weak.
- Generated `index.html` is large and duplicates the embedded data and all translations on every page load.

A pragmatic refactor is to extract browser JavaScript and CSS into source files, then copy or bundle them during generation. Separately export pure updater functions from modules and keep the executable entry point thin. This does not require introducing a framework.

## Recommended Order

1. [Done 2026-06-13] Fix routing cancellation and prevent stale requests from writing state or storage.
2. [Done 2026-06-13] Centralize URL validation and block SSRF targets and unsafe browser schemes.
3. Move generated-artifact validation after generation in CI.
4. Add regression tests for transit cancellation and event rendering.
5. Add network timeouts and Worker backlog protection.
6. Replace global heading scraping with scoped DOM parsing and stronger drift checks.
7. Tighten translation and reverse-geocode validation.
8. [Done 2026-06-13] Split browser assets out of the generator as the next maintainability improvement.

## Validation Performed

- `npm test`: passed.
- `node --check worker/index.js`: passed.
- `node --check scripts/update-site.mjs`: passed.
- `node --check scripts/group-data.mjs`: passed.
- `git diff --check`: passed before this review file was added.
- Translation key counts and value categories: consistent across all ten languages.
- Embedded initiative and translation JSON: parsed successfully.
- Cloudflare Worker dry run: bundle and bindings validated; Wrangler also emitted a sandbox-only log-write error because `/home/kevin/.config` is read-only.

`npm run update` was not executed because it contacts live source, Nextcloud, initiative, and geocoding services and rewrites generated data. Its pure and generated-script validations were covered by the checks above.
