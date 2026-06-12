import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const SOURCE_URL = "https://www.seebruecke.org/aktuelles/kampagnen/bezahlkarte";
const BUILD_GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
const PUBLIC_GEOCODE_API_URL = "/geocode";
const GEOCODE_CACHE_VERSION = "v3";
const WEBSITE_CHECK_TIMEOUT_MS = 10000;
const WEBSITE_CHECK_CONCURRENCY = 4;
const DATA_PATH = new URL("../data/initiatives.json", import.meta.url);
const CATALOG_PATH = new URL("../data/catalog.yml", import.meta.url);
const I18N_DIR = new URL("../data/i18n/", import.meta.url);
const GEOCODE_CACHE_PATH = new URL("../data/geocodes.json", import.meta.url);
const INDEX_PATH = new URL("../index.html", import.meta.url);
const LOGS_DIR = new URL("../logs/", import.meta.url);
const LEAFLET_DIST = new URL("../node_modules/leaflet/dist/", import.meta.url);
const LEAFLET_ASSETS = new URL("../assets/leaflet/", import.meta.url);
const COMPARED_INITIATIVE_FIELDS = [
  "name",
  "city",
  "region",
  "country",
  "address",
  "url",
  "coordinates",
  "locations",
  "notes",
  "transitLinks",
  "sources",
  "aliases"
];

const LANGUAGES = [
  { code: "de", label: "Deutsch", dir: "ltr" },
  { code: "en", label: "English", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "ru", label: "Русский", dir: "ltr" },
  { code: "ti", label: "ትግርኛ", dir: "ltr" },
  { code: "fa", label: "فارسی", dir: "rtl" },
  { code: "kmr", label: "Kurmancî", dir: "ltr" },
  { code: "tr", label: "Türkçe", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "uk", label: "Українська", dir: "ltr" }
];

const STATE_NAMES = new Set([
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen"
]);

const COUNTRY_NAMES = new Set(["Deutschland", "Österreich", "Austria", "Germany"]);
const SOCIAL_MEDIA_DOMAINS = [
  "bsky.app",
  "discord.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linkedin.com",
  "mastodon.social",
  "medium.com",
  "threads.net",
  "tiktok.com",
  "t.me",
  "telegram.me",
  "telegram.org",
  "twitter.com",
  "whatsapp.com",
  "x.com",
  "youtube.com",
  "youtu.be"
];

async function main(report) {
  const [html, catalog, translations, geocodeCache, previousData] = await Promise.all([
    fetchSource(),
    readCatalog(),
    readTranslations(),
    readGeocodeCache(),
    readPreviousData()
  ]);
  const scraped = parseInitiatives(html);
  const initiatives = mergeInitiatives(scraped, catalog, report);

  if (scraped.length < 20) {
    throw new Error(`Parsed only ${scraped.length} initiatives; source structure may have changed.`);
  }

  validateInitiatives(initiatives);
  await addCoordinates(initiatives, geocodeCache);
  await checkInitiativeWebsites(initiatives, report);
  initiatives.sort(compareInitiatives);

  const data = {
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    languages: LANGUAGES,
    initiatives
  };
  report.summary = {
    total: initiatives.length,
    scraped: scraped.length,
    curated: catalog.initiatives.length
  };
  report.changes = compareDatasets(previousData, data);
  report.websiteTransitions = compareWebsiteChecks(previousData, data);

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await copyLeafletAssets();
  await writeFile(GEOCODE_CACHE_PATH, `${JSON.stringify(geocodeCache, null, 2)}\n`);
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(INDEX_PATH, renderPage(data, translations));

  console.log(`Updated ${initiatives.length} initiatives (${scraped.length} scraped, ${catalog.initiatives.length} curated).`);
}

async function readPreviousData() {
  try {
    return JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function fetchSource() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent": "Anti-SocialCard.de updater; static initiative directory"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function readCatalog() {
  try {
    const parsed = parseYaml(await readFile(CATALOG_PATH, "utf8")) ?? {};
    return {
      initiatives: Array.isArray(parsed.initiatives) ? parsed.initiatives : [],
      overrides: Array.isArray(parsed.overrides) ? parsed.overrides : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return { initiatives: [], overrides: [] };
    throw error;
  }
}

async function readTranslations() {
  const entries = await Promise.all(LANGUAGES.map(async ({ code }) => {
    const value = JSON.parse(await readFile(new URL(`${code}.json`, I18N_DIR), "utf8"));
    return [code, value];
  }));
  const translations = Object.fromEntries(entries);
  const baseKeys = Object.keys(translations.de).sort();

  for (const [code, values] of Object.entries(translations)) {
    const keys = Object.keys(values).sort();
    const missing = baseKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !baseKeys.includes(key));
    if (missing.length || extra.length) {
      throw new Error(`Translation key mismatch in ${code}: missing=${missing.join(",")} extra=${extra.join(",")}`);
    }
  }

  return translations;
}

async function readGeocodeCache() {
  try {
    return JSON.parse(await readFile(GEOCODE_CACHE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function copyLeafletAssets() {
  await mkdir(LEAFLET_ASSETS, { recursive: true });
  await cp(new URL("leaflet.css", LEAFLET_DIST), new URL("leaflet.css", LEAFLET_ASSETS));
  await cp(new URL("leaflet.js", LEAFLET_DIST), new URL("leaflet.js", LEAFLET_ASSETS));
  await cp(new URL("images/", LEAFLET_DIST), new URL("images/", LEAFLET_ASSETS), { recursive: true });
}

function parseInitiatives(html) {
  const tokens = [...html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const initiatives = [];
  const scrapedUpdatedAt = new Date().toISOString().slice(0, 10);
  let country = "";
  let region = "";

  for (const token of tokens) {
    const level = Number(token[1]);
    const rawContent = token[2];
    const title = cleanText(rawContent);

    if (!title || title === "Mitmachen") continue;

    if (level === 2 && COUNTRY_NAMES.has(title)) {
      country = normalizeCountry(title);
      region = "";
      continue;
    }

    if (level === 3 && (STATE_NAMES.has(title) || country !== "Deutschland")) {
      region = title;
      continue;
    }

    if (level !== 4) continue;

    const link = rawContent.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const url = link ? new URL(decodeHtml(link[1]), SOURCE_URL).toString() : "";
    const normalizedCountry = country || "Deutschland";
    const normalizedRegion = region || (normalizedCountry === "Deutschland" ? "Bundesweit" : normalizedCountry);

    initiatives.push(normalizeInitiative({
      id: `seebruecke-${slugify(normalizedCountry)}-${slugify(normalizedRegion)}-${slugify(title)}`,
      name: title,
      city: title,
      region: normalizedRegion,
      country: normalizedCountry,
      url,
      updatedAt: scrapedUpdatedAt,
      sources: [{ label: "Seebrücke", url: SOURCE_URL }]
    }));
  }

  return initiatives;
}

function mergeInitiatives(scraped, catalog, report) {
  const byId = new Map(scraped.map((item) => [item.id, item]));
  const scrapedIds = new Set(byId.keys());

  for (const rawOverride of catalog.overrides) {
    const { match, ...fields } = rawOverride ?? {};
    const existing = findInitiative(byId, match);
    if (!existing) {
      const warning = `No initiative matched override: ${JSON.stringify(match)}`;
      report.warnings.push(warning);
      console.warn(warning);
      continue;
    }
    byId.set(existing.id, normalizeInitiative(deepMerge(existing, fields)));
  }

  for (const rawInitiative of catalog.initiatives) {
    const item = normalizeInitiative(rawInitiative);
    const existing = byId.get(item.id);
    for (const candidate of byId.values()) {
      if (scrapedIds.has(candidate.id) && samePlace(candidate, item)) {
        byId.delete(candidate.id);
      }
    }
    byId.set(item.id, normalizeInitiative(deepMerge(existing ?? {}, item)));
  }

  return [...byId.values()];
}

function samePlace(left, right) {
  return normalizeComparable(left.city) === normalizeComparable(right.city) &&
    normalizeComparable(left.region) === normalizeComparable(right.region) &&
    normalizeComparable(left.country) === normalizeComparable(right.country);
}

function normalizeInitiative(raw) {
  const url = raw.url ? String(raw.url) : "";
  const country = raw.country ? String(raw.country) : "Deutschland";
  const region = raw.region ?? raw.state ?? (country === "Deutschland" ? "Bundesweit" : country);
  const city = raw.city ?? raw.name;
  const sources = normalizeLinks(raw.sources);
  const transitLinks = normalizeLinks(raw.transitLinks);
  const locations = normalizeLocations(raw);

  return {
    id: raw.id ? String(raw.id) : `manual-${slugify(country)}-${slugify(region)}-${slugify(raw.name)}`,
    name: String(raw.name ?? "").trim(),
    city: String(city ?? "").trim(),
    region: String(region ?? "").trim(),
    country,
    address: String(raw.address ?? "").trim(),
    updatedAt: String(raw.updatedAt ?? "").trim(),
    url,
    domain: url ? new URL(url).hostname.replace(/^www\./, "") : "",
    coordinates: normalizeCoordinates(raw.coordinates),
    locations,
    notes: String(raw.notes ?? "").trim(),
    transitLinks,
    sources,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    websiteCheck: normalizeWebsiteCheck(raw.websiteCheck)
  };
}

function normalizeLocations(raw) {
  const values = Array.isArray(raw.locations) && raw.locations.length
    ? raw.locations
    : [{ address: raw.address, coordinates: raw.coordinates }];
  return values
    .map((location) => ({
      name: String(location?.name ?? "").trim(),
      address: String(location?.address ?? "").trim(),
      openingSlots: normalizeOpeningSlots(location?.openingSlots),
      notes: String(location?.notes ?? "").trim(),
      coordinates: normalizeCoordinates(location?.coordinates)
    }))
    .filter((location) => location.name || location.address || location.openingSlots.length || location.notes || location.coordinates);
}

function normalizeOpeningSlots(value) {
  if (!Array.isArray(value)) return [];
  return value.map((slot) => ({
    weekdays: Array.isArray(slot?.weekdays) ? slot.weekdays.map(Number) : [],
    weeksOfMonth: Array.isArray(slot?.weeksOfMonth) ? slot.weeksOfMonth.map(Number) : [],
    start: String(slot?.start ?? "").trim(),
    end: String(slot?.end ?? "").trim(),
    notes: String(slot?.notes ?? "").trim()
  }));
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((link) => link?.url)
    .map((link) => ({
      label: String(link.label ?? "Link"),
      url: String(link.url)
    }));
}

function normalizeCoordinates(value) {
  if (!value) return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    label: value.label ? String(value.label) : ""
  };
}

function normalizeWebsiteCheck(value) {
  if (!value || typeof value !== "object") return null;
  return {
    checkedAt: value.checkedAt ? String(value.checkedAt) : "",
    ok: Boolean(value.ok),
    status: Number.isFinite(Number(value.status)) ? Number(value.status) : null,
    finalUrl: value.finalUrl ? String(value.finalUrl) : "",
    method: value.method ? String(value.method) : "",
    error: value.error ? String(value.error) : ""
  };
}

function findInitiative(byId, match = {}) {
  if (match.id && byId.has(match.id)) return byId.get(match.id);
  const normalized = {
    name: normalizeComparable(match.name),
    region: normalizeComparable(match.region ?? match.state),
    country: normalizeComparable(match.country)
  };

  return [...byId.values()].find((item) => {
    const names = [item.name, item.city, ...item.aliases].map(normalizeComparable);
    return (!normalized.name || names.includes(normalized.name)) &&
      (!normalized.region || normalizeComparable(item.region) === normalized.region) &&
      (!normalized.country || normalizeComparable(item.country) === normalized.country);
  });
}

function validateInitiatives(initiatives) {
  const ids = new Set();

  for (const item of initiatives) {
    if (!item.id || !item.name || !item.region || !item.country) {
      throw new Error(`Invalid initiative: ${JSON.stringify(item)}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate initiative id: ${item.id}`);
    ids.add(item.id);
    for (const link of [item.url, ...item.sources.map((source) => source.url), ...item.transitLinks.map((link) => link.url)].filter(Boolean)) {
      new URL(link);
    }
    for (const location of item.locations) {
      for (const slot of location.openingSlots) {
        if (!slot.weekdays.length || slot.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
          throw new Error(`Invalid openingSlots weekdays in ${item.id}`);
        }
        if (slot.weeksOfMonth.some((week) => !Number.isInteger(week) || week < 1 || week > 5)) {
          throw new Error(`Invalid openingSlots weeksOfMonth in ${item.id}`);
        }
        if (![slot.start, slot.end].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
          throw new Error(`Invalid openingSlots time in ${item.id}`);
        }
      }
    }
  }
}

async function addCoordinates(initiatives, cache) {
  for (const initiative of initiatives) {
    if (!initiative.locations.length) {
      initiative.locations.push({ name: "", address: "", openingSlots: [], notes: "", coordinates: initiative.coordinates });
    }
    for (const location of initiative.locations) {
      if (location.coordinates) continue;
      const query = location.address || initiative.city || initiative.name;
      const key = `${GEOCODE_CACHE_VERSION}|${initiative.country}|${initiative.region}|${query}`;
      if (!(key in cache)) {
        const legacyKey = `v2|${initiative.country}|${initiative.region}|${initiative.name}`;
        if (!location.address && legacyKey in cache) {
          cache[key] = cache[legacyKey];
        } else {
          cache[key] = await geocodeInitiative(initiative, location.address);
          await delay(1100);
        }
      }
      location.coordinates = cache[key];
    }
    initiative.coordinates = initiative.locations.find((location) => location.coordinates)?.coordinates ?? null;
  }
}

async function checkInitiativeWebsites(initiatives, report) {
  const checkedAt = new Date().toISOString();
  const urls = [...new Set(initiatives
    .map((initiative) => initiative.url)
    .filter((url) => url && !isSocialMediaUrl(url)))];
  const results = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const url = urls[nextIndex++];
      results.set(url, await checkWebsite(url, checkedAt));
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(WEBSITE_CHECK_CONCURRENCY, urls.length) },
    () => worker()
  ));

  let failed = 0;
  for (const initiative of initiatives) {
    if (!initiative.url || isSocialMediaUrl(initiative.url)) {
      initiative.websiteCheck = null;
      continue;
    }
    initiative.websiteCheck = results.get(initiative.url) ?? null;
    if (initiative.websiteCheck && !initiative.websiteCheck.ok) {
      failed += 1;
      report.websiteFailures.push({
        id: initiative.id,
        name: initiative.name,
        url: initiative.url,
        status: initiative.websiteCheck.status,
        error: initiative.websiteCheck.error
      });
    }
  }

  console.log(`Checked ${urls.length} non-social initiative websites (${failed} failed).`);
}

async function checkWebsite(url, checkedAt) {
  try {
    let method = "HEAD";
    let response = await fetchWebsite(url, method);
    if ([403, 405, 501].includes(response.status)) {
      method = "GET";
      response = await fetchWebsite(url, method);
    }
    return websiteResult(checkedAt, response, method);
  } catch (error) {
    return {
      checkedAt,
      ok: false,
      status: null,
      finalUrl: "",
      method: "",
      error: error.name === "TimeoutError" ? "timeout" : String(error.message || error)
    };
  }
}

async function fetchWebsite(url, method) {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "user-agent": "Anti-SocialCard.de updater; link freshness check"
  };
  if (method === "GET") headers.range = "bytes=0-0";

  const response = await fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(WEBSITE_CHECK_TIMEOUT_MS),
    headers
  });
  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // Some servers close streams abruptly; status and final URL are still useful.
    }
  }
  return response;
}

function websiteResult(checkedAt, response, method) {
  return {
    checkedAt,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    method,
    error: ""
  };
}

function compareDatasets(previousData, currentData) {
  if (!previousData?.initiatives) {
    return {
      baselineAvailable: false,
      added: currentData.initiatives,
      removed: [],
      changed: []
    };
  }

  const previousById = new Map(previousData.initiatives.map((item) => [item.id, item]));
  const currentById = new Map(currentData.initiatives.map((item) => [item.id, item]));
  const added = currentData.initiatives.filter((item) => !previousById.has(item.id));
  const removed = previousData.initiatives.filter((item) => !currentById.has(item.id));
  const changed = [];

  for (const current of currentData.initiatives) {
    const previous = previousById.get(current.id);
    if (!previous) continue;
    const fields = COMPARED_INITIATIVE_FIELDS
      .filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(current[field] ?? null))
      .map((field) => ({
        field,
        before: previous[field] ?? null,
        after: current[field] ?? null
      }));
    if (fields.length) {
      changed.push({
        id: current.id,
        name: current.name,
        fields
      });
    }
  }

  return { baselineAvailable: true, added, removed, changed };
}

function compareWebsiteChecks(previousData, currentData) {
  if (!previousData?.initiatives) return [];
  const previousById = new Map(previousData.initiatives.map((item) => [item.id, item]));
  const transitions = [];

  for (const current of currentData.initiatives) {
    const previous = previousById.get(current.id);
    if (!previous || !current.websiteCheck || !previous.websiteCheck) continue;
    const before = websiteCheckState(previous.websiteCheck);
    const after = websiteCheckState(current.websiteCheck);
    if (before === after) continue;
    transitions.push({
      id: current.id,
      name: current.name,
      url: current.url,
      before,
      after
    });
  }

  return transitions;
}

function websiteCheckState(check) {
  if (check.ok) return "reachable";
  if (check.status) return `HTTP ${check.status}`;
  return check.error || "failed";
}

async function writeRunLog(report) {
  await mkdir(LOGS_DIR, { recursive: true });
  const finishedAt = new Date();
  const timestamp = report.startedAt.toISOString().replace(/[:.]/g, "-");
  const logPath = new URL(`${timestamp}.md`, LOGS_DIR);
  const lines = [
    `# Update log ${report.startedAt.toISOString()}`,
    "",
    `- Result: ${report.error ? "failed" : "success"}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Duration: ${finishedAt.getTime() - report.startedAt.getTime()} ms`
  ];

  if (report.summary) {
    lines.push(
      `- Initiatives: ${report.summary.total} total, ${report.summary.scraped} scraped, ${report.summary.curated} curated`
    );
  }

  if (report.error) {
    lines.push("", "## Fatal error", "", `- ${report.error}`);
  }

  appendWebsiteFailures(lines, report.websiteFailures);
  appendWebsiteTransitions(lines, report.websiteTransitions);
  appendDatasetChanges(lines, report.changes);
  appendListSection(lines, "Warnings", report.warnings);

  await writeFile(logPath, `${lines.join("\n")}\n`);
  console.log(`Wrote update log to logs/${timestamp}.md`);
}

function appendWebsiteFailures(lines, failures) {
  lines.push("", `## Failed initiative websites (${failures.length})`, "");
  if (!failures.length) {
    lines.push("- None");
    return;
  }
  for (const failure of failures) {
    const reason = failure.status ? `HTTP ${failure.status}` : failure.error || "unknown error";
    lines.push(`- **${failure.name}** (\`${failure.id}\`): ${failure.url} - ${reason}`);
  }
}

function appendWebsiteTransitions(lines, transitions) {
  lines.push("", `## Website status changes (${transitions.length})`, "");
  if (!transitions.length) {
    lines.push("- None");
    return;
  }
  for (const transition of transitions) {
    lines.push(
      `- **${transition.name}** (\`${transition.id}\`): ${transition.before} -> ${transition.after} - ${transition.url}`
    );
  }
}

function appendDatasetChanges(lines, changes) {
  lines.push("", "## Dataset changes", "");
  if (!changes) {
    lines.push("- Comparison unavailable because the run failed before a dataset was created.");
    return;
  }
  if (!changes.baselineAvailable) {
    lines.push("- No previous dataset was available; all initiatives are listed as added.");
  }

  appendInitiativeList(lines, "Added", changes.added);
  appendInitiativeList(lines, "Removed", changes.removed);
  lines.push("", `### Changed (${changes.changed.length})`, "");
  if (!changes.changed.length) {
    lines.push("- None");
    return;
  }
  for (const initiative of changes.changed) {
    lines.push(`- **${initiative.name}** (\`${initiative.id}\`)`);
    for (const change of initiative.fields) {
      lines.push(`  - \`${change.field}\`: ${formatLogValue(change.before)} -> ${formatLogValue(change.after)}`);
    }
  }
}

function appendInitiativeList(lines, title, initiatives) {
  lines.push("", `### ${title} (${initiatives.length})`, "");
  if (!initiatives.length) {
    lines.push("- None");
    return;
  }
  for (const initiative of initiatives) {
    lines.push(`- **${initiative.name}** (\`${initiative.id}\`)${initiative.url ? ` - ${initiative.url}` : ""}`);
  }
}

function appendListSection(lines, title, values) {
  lines.push("", `## ${title} (${values.length})`, "");
  lines.push(...(values.length ? values.map((value) => `- ${value}`) : ["- None"]));
}

function formatLogValue(value) {
  const serialized = JSON.stringify(value);
  const shortened = serialized.length > 500 ? `${serialized.slice(0, 497)}...` : serialized;
  return `\`${shortened.replace(/`/g, "\\`")}\``;
}

function isSocialMediaUrl(value) {
  const hostname = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  return SOCIAL_MEDIA_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

async function geocodeInitiative(initiative, address = "") {
  const country = initiative.country === "Österreich" ? "Austria" : "Germany";
  if (address) {
    try {
      const result = await fetchGeocode(new URLSearchParams({
        q: [address, initiative.city, initiative.region, country].filter(Boolean).join(", "),
        format: "jsonv2",
        limit: "1",
        addressdetails: "0"
      }));
      if (!result) return null;
      return {
        lat: Number(result.lat),
        lon: Number(result.lon),
        label: result.display_name
      };
    } catch {
      return null;
    }
  }

  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    addressdetails: "0"
  });
  const locationName = normalizeLocationName(initiative.city || initiative.name);

  if (initiative.name === initiative.region || STATE_NAMES.has(initiative.name)) {
    params.set("state", initiative.name);
  } else if (/landkreis|kreis/i.test(initiative.name)) {
    params.set("county", locationName);
    if (initiative.country !== "Österreich") params.set("state", initiative.region);
  } else {
    params.set("city", locationName);
    if (initiative.country !== "Österreich") params.set("state", initiative.region);
  }
  params.set("country", country);

  try {
    let result = await fetchGeocode(params);
    if (!result) {
      const fallback = new URLSearchParams({
        q: [locationName, initiative.region !== initiative.country ? initiative.region : "", country].filter(Boolean).join(", "),
        format: "jsonv2",
        limit: "1",
        addressdetails: "0"
      });
      result = await fetchGeocode(fallback);
    }
    if (!result) return null;
    return {
      lat: Number(result.lat),
      lon: Number(result.lon),
      label: result.display_name
    };
  } catch {
    return null;
  }
}

async function fetchGeocode(params) {
  const response = await fetch(`${BUILD_GEOCODE_URL}?${params}`, {
    headers: {
      "user-agent": "Anti-SocialCard.de updater; static initiative directory"
    }
  });
  if (!response.ok) return null;
  const [result] = await response.json();
  return result ?? null;
}

function renderPage(data, translations) {
  const regions = [...new Set(data.initiatives.map((item) => item.region))].sort((a, b) => a.localeCompare(b, "de"));
  const geocodedCount = data.initiatives.filter((item) => item.coordinates).length;
  const updated = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Berlin"
  }).format(new Date(data.updatedAt));

  return `<!doctype html>
<html lang="de" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Mehrsprachige Übersicht von Initiativen und Tauschaktionen gegen die Bezahlkarte für Geflüchtete.">
  <title>Tauschaktionen Finder</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #151515;
      --muted: #626262;
      --paper: #f8f8f5;
      --panel: #ffffff;
      --line: #ddddda;
      --accent: #0f6760;
      --accent-soft: #e7f0ee;
      --focus: #123c69;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--paper);
      line-height: 1.45;
    }

    a { color: inherit; }

    .wrap {
      width: min(1120px, calc(100% - 28px));
      margin: 0 auto;
    }

    header {
      border-bottom: 1px solid var(--line);
    }

    .hero {
      display: grid;
      gap: 22px;
      padding: 34px 0 24px;
    }

    .topline {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .brand {
      margin: 0;
      font-weight: 760;
      font-size: 1rem;
    }

    .language-switcher {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .language-switcher button {
      min-height: 34px;
      padding: 0 10px;
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 999px;
      font-weight: 650;
    }

    .language-switcher button[aria-pressed="true"] {
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }

    h1 {
      max-width: 760px;
      margin: 0;
      font-size: clamp(2rem, 6vw, 4.35rem);
      line-height: 1.02;
      letter-spacing: 0;
      font-weight: 780;
    }

    .intro {
      max-width: 720px;
      margin: 0;
      color: var(--muted);
      font-size: clamp(1rem, 2vw, 1.14rem);
    }

    .quick-start {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      align-items: end;
      padding: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .place-suggestions {
      grid-column: 1 / -1;
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .location-privacy {
      grid-column: 1 / -1;
      margin: 0;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.45;
    }

    .location-privacy a { color: inherit; }

    .place-suggestions button {
      width: 100%;
      min-height: 0;
      padding: 10px 12px;
      border-color: var(--line);
      background: var(--panel);
      color: var(--ink);
      text-align: start;
      font-weight: 650;
    }

    .place-suggestions button:hover {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .place-suggestions small {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-weight: 500;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 0.84rem;
      font-weight: 690;
    }

    input, select, button {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--ink);
      font: inherit;
    }

    input, select { width: 100%; padding: 0 12px; }

    button {
      padding: 0 14px;
      cursor: pointer;
      font-weight: 720;
      background: var(--ink);
      color: #fff;
      border-color: var(--ink);
    }

    button.secondary {
      background: var(--panel);
      color: var(--ink);
      border-color: var(--line);
    }

    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }

    main { padding: 20px 0 56px; }

    .status {
      min-height: 22px;
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 0.94rem;
    }

    .transit-preferences {
      display: grid;
      gap: 10px;
      margin-bottom: 20px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .transit-preferences h2, .transit-preferences p { margin: 0; }

    .transit-preferences p {
      color: var(--muted);
      line-height: 1.5;
    }

    .transit-preference-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .transit-preference-actions button {
      flex: 1 1 220px;
      background: var(--panel);
      color: var(--ink);
      border-color: var(--line);
    }

    .transit-privacy summary {
      width: fit-content;
      cursor: pointer;
      color: var(--accent);
      font-weight: 690;
    }

    .transit-privacy p { margin-top: 8px; }

    .footer-settings {
      min-height: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      text-decoration: underline;
      font-weight: inherit;
    }

    .section {
      padding: 20px 0;
      border-top: 1px solid var(--line);
    }

    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: end;
      margin-bottom: 10px;
    }

    h2 {
      margin: 0;
      font-size: clamp(1.25rem, 3vw, 1.8rem);
      line-height: 1.12;
      font-weight: 760;
      letter-spacing: 0;
    }

    .count, .meta {
      color: var(--muted);
      font-size: 0.92rem;
    }

    .map-panel {
      display: grid;
      gap: 10px;
    }

    .map-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    #map {
      display: none;
      min-height: 430px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #e9ece8;
    }

    .filters {
      position: sticky;
      top: 0;
      z-index: 3;
      display: grid;
      grid-template-columns: 1.2fr 0.8fr auto;
      gap: 10px;
      align-items: end;
      padding: 12px 0;
      background: rgba(248, 248, 245, 0.95);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--line);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 8px;
    }

    #nearest-grid {
      grid-template-columns: 1fr;
      gap: 10px;
    }

    .load-more {
      display: block;
      margin: 14px auto 0;
    }

    .initiative {
      display: grid;
      gap: 10px;
      min-height: 126px;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .initiative h3 {
      margin: 0;
      font-size: 1.05rem;
      line-height: 1.25;
      font-weight: 760;
      overflow-wrap: anywhere;
    }

    .initiative p {
      margin: 0;
      color: var(--muted);
      font-size: 0.92rem;
      overflow-wrap: anywhere;
    }

    .initiative .initiative-name {
      margin-top: 2px;
      color: var(--ink);
      font-weight: 650;
    }

    .locations {
      display: grid;
      gap: 7px;
      margin-top: 10px;
    }

    .location {
      padding: 9px 10px;
      border-left: 3px solid var(--accent);
      border-radius: 0 6px 6px 0;
      background: var(--accent-soft);
    }

    .location .links { margin-top: 8px; }

    .initiative .location-name {
      color: var(--ink);
      font-weight: 690;
    }

    .opening-hours {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 7px;
      align-items: start;
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid rgba(15, 103, 96, 0.18);
    }

    .initiative .opening-hours-label {
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--panel);
      color: var(--accent);
      font-size: 0.7rem;
      font-weight: 760;
      line-height: 1.55;
      white-space: nowrap;
    }

    .initiative .opening-hours-value {
      display: grid;
      gap: 3px;
      color: var(--ink);
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .initiative .opening-hours-row + .opening-hours-row {
      padding-top: 3px;
      border-top: 1px dashed rgba(15, 103, 96, 0.18);
    }

    .initiative .notes {
      margin-top: 7px;
      color: var(--ink);
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .initiative .slot-notes {
      display: block;
      color: var(--muted);
      font-size: 0.8rem;
    }

    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .links a {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 0 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      text-decoration: none;
      font-size: 0.88rem;
      font-weight: 690;
    }

    .links a:hover, .links a:focus-visible {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .proximity {
      display: grid;
      gap: 4px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--paper);
    }

    .proximity-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      color: var(--ink);
      font-size: 0.88rem;
      font-weight: 680;
    }

    .distance { color: var(--accent); font-weight: 760; }

    .proximity-status {
      color: var(--muted);
      font-size: 0.86rem;
    }

    .nearest-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }

    .transitous-link {
      border-color: var(--accent) !important;
      color: var(--accent);
    }

    .card-footer {
      display: flex;
      gap: 10px;
      align-items: end;
      justify-content: space-between;
      align-self: end;
    }

    .updated-at {
      margin-left: auto;
      color: var(--muted);
      font-size: 0.72rem;
      text-align: end;
      white-space: nowrap;
    }

    .no-results {
      display: none;
      padding: 22px 0;
      color: var(--muted);
    }

    .all-initiatives {
      margin-top: 20px;
      border-top: 1px solid var(--line);
    }

    .all-initiatives > summary {
      padding: 18px 0;
      cursor: pointer;
      font-size: 1.08rem;
      font-weight: 760;
    }

    .all-initiatives[open] > summary {
      border-bottom: 1px solid var(--line);
    }

    footer {
      padding: 24px 0 42px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.92rem;
    }

    [hidden] { display: none !important; }

    @media (max-width: 760px) {
      .wrap { width: min(100% - 20px, 1120px); }
      .hero { padding: 22px 0 18px; }
      .quick-start, .filters { grid-template-columns: 1fr; padding-left: 0; padding-right: 0; }
      .quick-start { padding: 14px; }
      .section-head { align-items: flex-start; flex-direction: column; }
      button { width: 100%; }
      .language-switcher button, .footer-settings { width: auto; }
      #map { min-height: 340px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap hero">
      <div class="topline">
        <p class="brand">Tauschaktionen Finder</p>
        <nav class="language-switcher" id="language-switcher" aria-label="Language"></nav>
      </div>
      <h1 data-i18n="title">Initiativen gegen die Bezahlkarte</h1>
      <p class="intro" data-i18n="intro">Eine Übersicht lokaler Gruppen und Tauschaktionen.</p>
      <p class="status" id="location-status" role="status" aria-live="polite" data-i18n="statusDefault"></p>
      <form class="quick-start" id="locator">
        <label>
          <span data-i18n="locationLabel">Dein Ort</span>
          <input id="location" autocomplete="off" aria-controls="place-suggestions" data-i18n-placeholder="locationPlaceholder">
        </label>
        <button type="submit" data-i18n="findNearest">Nächste finden</button>
        <button class="secondary" type="button" id="use-location" data-i18n="useLocation">Standort nutzen</button>
        <ul class="place-suggestions" id="place-suggestions" aria-label="Mögliche Orte" data-i18n-aria-label="placeSuggestionsLabel" hidden></ul>
        <p class="location-privacy">
          <span data-i18n="locationPrivacyNotice">Die Ortssuche wird über unseren Cloudflare-Dienst an OpenStreetMap Nominatim weitergeleitet. Dabei verarbeiten Cloudflare und Nominatim Suchbegriff beziehungsweise Standortkoordinaten, IP-Adresse und technische Verbindungsdaten.</span>
          <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer" data-i18n="locationCloudflarePrivacyLink">Cloudflare-Datenschutz</a>
          <span> · </span>
          <a href="https://osmfoundation.org/wiki/Privacy_Policy" target="_blank" rel="noopener noreferrer" data-i18n="locationPrivacyLink">OSMF-Datenschutz</a>
        </p>
      </form>
    </div>
  </header>

  <main class="wrap">
    <section class="transit-preferences" id="transit-preferences" aria-labelledby="transit-preferences-title" hidden>
      <h2 id="transit-preferences-title" data-i18n="transitConsentTitle">Fahrzeiten mit öffentlichen Verkehrsmitteln anzeigen?</h2>
      <p data-i18n="transitConsentDescription">Dafür fragen wir Transitous ab und speichern Ergebnisse sechs Stunden in deinem Browser. So vermeiden wir wiederholte Anfragen.</p>
      <div class="transit-preference-actions">
        <button type="button" class="secondary" id="enable-transit" data-i18n="transitEnable">ÖPNV-Zeiten aktivieren</button>
        <button type="button" class="secondary" id="decline-transit" data-i18n="transitDecline">Nur Entfernungen anzeigen</button>
      </div>
      <details class="transit-privacy">
        <summary data-i18n="transitPrivacySummary">Datenschutzhinweise</summary>
        <p>
          <span data-i18n="transitPrivacyDetails">Bei Aktivierung werden dein gewählter Ausgangsort, die Ziele und Routenoptionen an Transitous übertragen. Transitous kann deine IP-Adresse, den Anfragezeitpunkt, den User-Agent und die angefragten Routendaten bis zu zwei Tage in Serverprotokollen speichern. Routenergebnisse werden höchstens sechs Stunden in deinem Browser gespeichert. Du kannst die Funktion jederzeit deaktivieren und den lokalen Cache löschen.</span>
          <a href="https://transitous.org/privacy/" target="_blank" rel="noopener noreferrer" data-i18n="transitPrivacyLink">Transitous-Datenschutz</a>
        </p>
      </details>
    </section>

    <div id="results" hidden>
      <section class="section" id="nearest" aria-live="polite">
        <div class="section-head">
          <h2 data-i18n="nearestTitle">Nächste Initiativen</h2>
          <div class="nearest-actions">
            <span class="count" id="nearest-count"></span>
            <button type="button" class="secondary" id="sort-nearest" disabled></button>
          </div>
        </div>
        <div class="grid" id="nearest-grid"></div>
        <button type="button" class="secondary load-more" id="load-more" data-i18n="loadMore">Mehr laden</button>
      </section>

      <section class="section map-panel">
        <div class="section-head">
          <h2 data-i18n="mapTitle">Karte</h2>
          <span class="meta" data-i18n="mapOptIn">Die Karte lädt erst nach Aktivierung.</span>
        </div>
        <div class="map-actions">
          <button type="button" id="show-map" class="secondary" data-i18n="showMap">Karte anzeigen</button>
          <span class="meta" id="map-status"></span>
        </div>
        <div id="map" role="region" aria-label="Map"></div>
      </section>

      <details class="all-initiatives">
        <summary data-i18n="allTitle">Alle Initiativen</summary>
        <form class="filters" id="filters">
          <label>
            <span data-i18n="searchLabel">Suche</span>
            <input id="search" type="search" autocomplete="off" data-i18n-placeholder="searchPlaceholder">
          </label>
          <label>
            <span data-i18n="regionLabel">Region</span>
            <select id="region">
              <option value="" data-i18n="allRegions">Alle Regionen</option>
              ${regions.map((region) => `<option value="${escapeAttribute(region)}">${escapeHtml(region)}</option>`).join("")}
            </select>
          </label>
          <button type="reset" class="secondary" data-i18n="reset">Zurücksetzen</button>
        </form>

        <p class="meta">
          <span data-i18n="updatedLabel">Zuletzt aktualisiert</span>:
          <time datetime="${escapeAttribute(data.updatedAt)}">${escapeHtml(updated)}</time>.
        </p>

        <section class="section">
          <div class="section-head">
            <h2 data-i18n="allTitle">Alle Initiativen</h2>
            <span class="count" id="list-count"></span>
          </div>
          <div id="list"></div>
          <p class="no-results" id="no-results" data-i18n="noResults">Keine passenden Initiativen gefunden.</p>
        </section>
      </details>
    </div>
  </main>

  <footer>
    <div class="wrap">
      <span data-i18n="footer"></span>
      <span> </span>
      <a href="https://transitous.org/sources/" target="_blank" rel="noopener noreferrer" data-i18n="transitousAttribution">Fahrplandaten: Transitous.</a>
      <span> </span>
      <button type="button" class="footer-settings" id="transit-settings" data-i18n="transitSettings">Datenschutz- und ÖPNV-Einstellungen</button>
      <span> </span>
      <a href="mailto:anti-socialcard@systemli.org">anti-socialcard@systemli.org</a>
      <span> </span>
      <a href="https://github.com/Bobylein/anti-socialcard" target="_blank" rel="noopener noreferrer" data-i18n="contactLink">Kontakt und Quellcode.</a>
    </div>
  </footer>

  <script type="application/json" id="initiative-data">${escapeScriptJson(toPageInitiatives(data.initiatives))}</script>
  <script type="application/json" id="translation-data">${escapeScriptJson(translations)}</script>
  <script type="application/json" id="language-data">${escapeScriptJson(LANGUAGES)}</script>
  <script>
    const initiatives = JSON.parse(document.getElementById("initiative-data").textContent);
    const translations = JSON.parse(document.getElementById("translation-data").textContent);
    const languages = JSON.parse(document.getElementById("language-data").textContent);
    const languageSwitcher = document.getElementById("language-switcher");
    const locator = document.getElementById("locator");
    const locationInput = document.getElementById("location");
    const placeSuggestions = document.getElementById("place-suggestions");
    const useLocation = document.getElementById("use-location");
    const locationStatus = document.getElementById("location-status");
    const transitPreferences = document.getElementById("transit-preferences");
    const enableTransitButton = document.getElementById("enable-transit");
    const declineTransitButton = document.getElementById("decline-transit");
    const transitSettingsButton = document.getElementById("transit-settings");
    const results = document.getElementById("results");
    const nearest = document.getElementById("nearest");
    const nearestGrid = document.getElementById("nearest-grid");
    const nearestCount = document.getElementById("nearest-count");
    const sortNearestButton = document.getElementById("sort-nearest");
    const loadMoreButton = document.getElementById("load-more");
    const showMapButton = document.getElementById("show-map");
    const mapStatus = document.getElementById("map-status");
    const mapElement = document.getElementById("map");
    const search = document.getElementById("search");
    const region = document.getElementById("region");
    const list = document.getElementById("list");
    const listCount = document.getElementById("list-count");
    const noResults = document.getElementById("no-results");
    const filters = document.getElementById("filters");
    const GEOCODE_API_URL = ${escapeScriptJson(PUBLIC_GEOCODE_API_URL)}.replace(/\\/+$/, "");
    const TRANSITOUS_URL = "https://api.transitous.org/api/v6/plan";
    const TRANSIT_PREFERENCE_KEY = "anti-socialcard-transit-preference-v1";
    const ROUTE_CACHE_KEY = "anti-socialcard-transitous-city-v8";
    const LEGACY_CACHE_KEYS = [
      "anti-socialcard-transitous-city-v7",
      "anti-socialcard-origin-labels-v1"
    ];
    const BERLIN_TIME_ZONE = "Europe/Berlin";
    let currentLanguage = chooseInitialLanguage();
    let transitPreference = readTransitPreference();
    let currentOrigin = null;
    let originRouteLabel = "";
    let map = null;
    let markerLayer = null;
    let originLayer = null;
    let leafletLoading = null;
    let locationRequestPending = false;
    let rankedNearest = [];
    let nearestVisibleCount = 5;
    let nearestSortMode = "distance";
    let routingGeneration = 0;
    const cityStationCache = new Map();
    const reverseGeocodeCache = new Map();

    init();

    function init() {
      renderLanguageSwitcher();
      applyLanguage(currentLanguage);
      renderList(initiatives);
      bindEvents();
    }

    function bindEvents() {
      search.addEventListener("input", applyFilters);
      region.addEventListener("change", applyFilters);
      filters.addEventListener("reset", () => requestAnimationFrame(applyFilters));
      loadMoreButton.addEventListener("click", () => {
        nearestVisibleCount += 5;
        nearestSortMode = "distance";
        renderNearest();
        routeVisibleInitiatives();
      });
      sortNearestButton.addEventListener("click", () => {
        nearestSortMode = nearestSortMode === "transit" ? "distance" : "transit";
        renderNearest();
      });
      locator.addEventListener("submit", async (event) => {
        event.preventDefault();
        const place = locationInput.value.trim();
        if (!place) return;
        clearPlaceSuggestions();
        setStatus("statusSearchingPlace");
        try {
          const places = await geocodePlaces(place);
          if (places.length === 1) {
            await selectPlace(place, places[0]);
          } else {
            renderPlaceSuggestions(places);
            setStatus("statusChoosePlace");
          }
        } catch (error) {
          locationStatus.textContent = error.message;
        }
      });
      placeSuggestions.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-place-index]");
        if (!button) return;
        const place = locationInput.value.trim();
        const selected = placeSuggestions.currentPlaces?.[Number(button.dataset.placeIndex)];
        if (!selected) return;
        await selectPlace(place, selected);
      });
      locationInput.addEventListener("input", clearPlaceSuggestions);
      enableTransitButton.addEventListener("click", enableTransit);
      declineTransitButton.addEventListener("click", disableTransit);
      transitSettingsButton.addEventListener("click", () => {
        renderTransitPreferences(true);
        transitPreferences.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      useLocation.addEventListener("click", () => {
        clearPlaceSuggestions();
        if (locationRequestPending) return;
        if (!window.isSecureContext) {
          setStatus("statusLocationInsecure");
          return;
        }
        if (!navigator.geolocation) {
          setStatus("statusLocationUnsupported");
          return;
        }
        locationRequestPending = true;
        useLocation.disabled = true;
        useLocation.setAttribute("aria-busy", "true");
        setStatus("statusWaitingLocation");
        try {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              finishLocationRequest();
              const origin = {
                lat: position.coords.latitude,
                lon: position.coords.longitude
              };
              showNearest(origin, t("yourLocation"));
              resolveOriginLabel(origin);
            },
            (error) => {
              finishLocationRequest();
              if (error.code === error.PERMISSION_DENIED) {
                setStatus("statusLocationDenied");
              } else if (error.code === error.TIMEOUT) {
                setStatus("statusLocationTimeout");
              } else {
                setStatus("statusLocationFailed");
              }
            },
            { enableHighAccuracy: false, timeout: 30000, maximumAge: 300000 }
          );
        } catch {
          finishLocationRequest();
          setStatus("statusLocationFailed");
        }
      });
      showMapButton.addEventListener("click", () => enableMap());
    }

    function finishLocationRequest() {
      locationRequestPending = false;
      useLocation.disabled = false;
      useLocation.removeAttribute("aria-busy");
    }

    function chooseInitialLanguage() {
      const params = new URLSearchParams(location.search);
      const requested = params.get("lang") || navigator.language.slice(0, 2);
      if (languages.some((language) => language.code === requested)) return requested;
      if (requested === "ku") return "kmr";
      return "de";
    }

    function renderLanguageSwitcher() {
      languageSwitcher.innerHTML = languages.map((language) =>
        '<button type="button" data-lang="' + escapeHtml(language.code) + '">' + escapeHtml(language.label) + '</button>'
      ).join("");
      languageSwitcher.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-lang]");
        if (!button) return;
        applyLanguage(button.dataset.lang);
      });
    }

    function applyLanguage(code) {
      currentLanguage = translations[code] ? code : "de";
      const language = languages.find((item) => item.code === currentLanguage);
      document.documentElement.lang = currentLanguage;
      document.documentElement.dir = language?.dir || "ltr";
      const url = new URL(location.href);
      url.searchParams.set("lang", currentLanguage);
      history.replaceState(null, "", url);
      document.querySelectorAll("[data-i18n]").forEach((element) => {
        element.textContent = t(element.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
        element.placeholder = t(element.dataset.i18nPlaceholder);
      });
      document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
        element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
      });
      languageSwitcher.querySelectorAll("button").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.lang === currentLanguage));
      });
      applyFilters();
      renderTransitPreferences(!transitPreferences.hidden);
      if (currentOrigin) {
        renderNearest();
        locationStatus.textContent = t("statusSortedPrefix") + " " + currentOrigin.label + ".";
      }
    }

    function t(key) {
      return translations[currentLanguage]?.[key] ?? translations.de[key] ?? key;
    }

    function setStatus(key) {
      locationStatus.textContent = t(key);
    }

    function readTransitPreference() {
      try {
        const value = localStorage.getItem(TRANSIT_PREFERENCE_KEY);
        return value === "enabled" || value === "disabled" ? value : "unknown";
      } catch {
        return "unknown";
      }
    }

    function writeTransitPreference(value) {
      transitPreference = value;
      try {
        localStorage.setItem(TRANSIT_PREFERENCE_KEY, value);
      } catch {
        // The preference remains active for this page view when storage is unavailable.
      }
    }

    function renderTransitPreferences(forceOpen = false) {
      const shouldShow = forceOpen || (currentOrigin && transitPreference === "unknown");
      transitPreferences.hidden = !shouldShow;
      enableTransitButton.hidden = transitPreference === "enabled";
      declineTransitButton.textContent = transitPreference === "enabled"
        ? t("transitDisable")
        : t("transitDecline");
    }

    function enableTransit() {
      writeTransitPreference("enabled");
      transitPreferences.hidden = true;
      markRoutesPending();
      renderNearest();
      routeVisibleInitiatives();
    }

    function disableTransit() {
      routingGeneration += 1;
      writeTransitPreference("disabled");
      try {
        localStorage.removeItem(ROUTE_CACHE_KEY);
        for (const key of LEGACY_CACHE_KEYS) localStorage.removeItem(key);
      } catch {
        // There may be no accessible cache to remove.
      }
      nearestSortMode = "distance";
      for (const item of rankedNearest) item.routeState = { status: "disabled" };
      transitPreferences.hidden = true;
      renderNearest();
    }

    function markRoutesPending() {
      for (const item of rankedNearest) {
        if (item.routeState.status !== "success") {
          item.routeState = { status: transitPreference === "enabled" ? "pending" : "disabled" };
        }
      }
    }

    function renderList(items) {
      const grouped = groupBy(items, (item) => item.region);
      const regions = [...grouped.keys()].sort((a, b) => a.localeCompare(b, "de"));
      list.innerHTML = regions.map((name) => {
        const entries = grouped.get(name);
        return '<section class="section region-section" data-region="' + escapeHtml(name) + '">' +
          '<div class="section-head"><h2>' + escapeHtml(name) + '</h2><span class="count">' + formatEntries(entries.length) + '</span></div>' +
          '<div class="grid">' + entries.map((item) => renderCard(item)).join("") + '</div>' +
          '</section>';
      }).join("");
      listCount.textContent = formatEntries(items.length);
    }

    function renderCard(item, distance, routeState) {
      const links = [];
      if (item.url) links.push('<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' + t("website") + '</a>');
      for (const link of item.transitLinks || []) {
        links.push('<a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(link.label || t("transit")) + '</a>');
      }
      const title = item.city || item.name;
      const initiativeName = item.city ? '<p class="initiative-name">' + escapeHtml(item.name) + '</p>' : "";
      const initiativeNotes = item.notes ? renderNotes(item.notes) : "";
      const locations = getLocations(item).map((location) => renderLocationDetails(location, Number.isFinite(distance) ? item : null)).filter(Boolean).join("");
      const locationDetails = locations ? '<div class="locations">' + locations + '</div>' : "";
      const proximity = Number.isFinite(distance) ? renderProximity(distance, routeState) : "";
      const updatedAt = item.updatedAt ? '<span class="updated-at">' + escapeHtml(t("updatedLabel") + ": " + formatDate(item.updatedAt)) + '</span>' : "";
      return '<article class="initiative" data-id="' + escapeHtml(item.id) + '">' +
        '<div><h3>' + escapeHtml(title) + '</h3>' + initiativeName + initiativeNotes + locationDetails + '</div>' + proximity +
        '<div class="card-footer"><div class="links">' + links.join("") + '</div>' + updatedAt + '</div>' +
        '</article>';
    }

    function renderProximity(distance, routeState) {
      const distanceText = '<span class="distance">' + Math.round(distance) + ' ' + escapeHtml(t("distanceKm")) + '</span>';
      if (!routeState || routeState.status === "disabled") {
        return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div></div>';
      }
      if (routeState.status === "pending") {
        return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitWaiting")) + '</span></div>';
      }
      if (routeState.status === "loading") {
        return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitLoading")) + '</span></div>';
      }
      if (routeState.status === "error") {
        return '<div class="proximity"><div class="proximity-summary">' + distanceText + '</div><span class="proximity-status">' + escapeHtml(t("transitUnavailable")) + '</span></div>';
      }
      return '<div class="proximity"><div class="proximity-summary">' + distanceText + '<span>' +
        escapeHtml(t("cityTravelTime") + ": " + formatDuration(routeState.duration)) +
        '</span></div><span class="proximity-status">' +
        escapeHtml(routeState.fromStation + " → " + routeState.toStation) +
        '</span></div>';
    }

    function renderLocationDetails(location, item) {
      const title = [location.name, location.address].filter(Boolean).join(" · ");
      const openingHourRows = formatOpeningSlots(location.openingSlots);
      const openingHours = openingHourRows.length
        ? '<div class="opening-hours"><span class="opening-hours-label">' + escapeHtml(t("openingHoursLabel")) + '</span><span class="opening-hours-value">' +
          openingHourRows.map((row) => '<span class="opening-hours-row">' + escapeHtml(row.schedule) +
            (row.notes ? '<span class="slot-notes">' + escapeHtml(row.notes) + '</span>' : "") + '</span>').join("") + '</span></div>'
        : "";
      const notes = location.notes ? renderNotes(location.notes) : "";
      const routeLink = transitPreference === "enabled" && item && location.coordinates
        ? '<div class="links"><a class="transitous-link" href="' + escapeHtml(buildTransitousUrl(item, location)) +
          '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t("transitousRoute")) + '</a></div>'
        : "";
      if (!title && !openingHours && !notes && !routeLink) return "";
      return '<div class="location"><p class="location-name">' + escapeHtml(title) + '</p>' +
        openingHours + notes + routeLink + '</div>';
    }

    function renderNotes(value) {
      return '<p class="notes"><strong>' + escapeHtml(t("notesLabel")) + ':</strong> ' + escapeHtml(value) + '</p>';
    }

    function formatOpeningSlots(slots = []) {
      return slots.map((slot) => {
        const weekdays = new Intl.ListFormat(currentLanguage, { style: "long", type: "conjunction" }).format(
          slot.weekdays.map(formatWeekday)
        );
        const recurrence = slot.weeksOfMonth?.length
          ? formatMonthlyRecurrence(slot, weekdays)
          : t("openingSlotWeekly").replace("{weekday}", weekdays);
        const [startHour, startMinute] = slot.start.split(":").map(Number);
        const [endHour, endMinute] = slot.end.split(":").map(Number);
        return {
          schedule: recurrence + " · " + formatTimeRange(startHour, startMinute, endHour, endMinute),
          notes: slot.notes || ""
        };
      });
    }

    function formatMonthlyRecurrence(slot, weekdays) {
      const ordinalKey = usesFeminineOrdinals(slot)
        ? "openingSlotOrdinalsFeminine"
        : "openingSlotOrdinals";
      const ordinalValues = t(ordinalKey);
      const ordinals = new Intl.ListFormat(currentLanguage, { style: "long", type: "conjunction" }).format(
        slot.weeksOfMonth.map((week) => ordinalValues[week - 1])
      );
      return capitalizeFirst(t("openingSlotMonthly")
        .replace("{ordinals}", ordinals)
        .replace("{weekday}", weekdays));
    }

    function usesFeminineOrdinals(slot) {
      if (slot.weekdays.length !== 1) return false;
      const weekday = slot.weekdays[0];
      return ((currentLanguage === "ru" || currentLanguage === "uk") && [3, 5].includes(weekday)) ||
        (currentLanguage === "ar" && weekday === 5);
    }

    function capitalizeFirst(value) {
      return value ? value.charAt(0).toLocaleUpperCase(currentLanguage) + value.slice(1) : value;
    }

    function formatWeekday(weekday) {
      const date = new Date(Date.UTC(2024, 0, Number(weekday)));
      return new Intl.DateTimeFormat(currentLanguage, { weekday: "long", timeZone: "UTC" }).format(date);
    }

    function formatTime(hour, minute) {
      const value = timeValue(hour, minute);
      return timeFormatter24().format(value) + " / " + timeFormatter12().format(value);
    }

    function formatTimeRange(startHour, startMinute, endHour, endMinute) {
      const start = timeValue(startHour, startMinute);
      const end = timeValue(endHour, endMinute, endHour * 60 + endMinute <= startHour * 60 + startMinute ? 2 : 1);
      return formatRange(timeFormatter24(), start, end) + " / " + formatRange(timeFormatter12(), start, end);
    }

    function formatRange(formatter, start, end) {
      return typeof formatter.formatRange === "function"
        ? formatter.formatRange(start, end)
        : formatter.format(start) + "–" + formatter.format(end);
    }

    function timeFormatter24() {
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "UTC"
      });
    }

    function timeFormatter12() {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: "h12",
        timeZone: "UTC"
      });
    }

    function timeValue(hour, minute, day = 1) {
      return new Date(Date.UTC(2000, 0, day, hour, minute));
    }

    function formatDate(value) {
      const date = new Date(value + (value.length === 10 ? "T00:00:00Z" : ""));
      return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(currentLanguage).format(date);
    }

    function formatDuration(seconds) {
      const minutes = Math.max(0, Math.round(seconds / 60));
      const hours = Math.floor(minutes / 60);
      const remaining = minutes % 60;
      if (!hours) return minutes + " " + t("minutesShort");
      return hours + " " + t("hoursShort") + (remaining ? " " + remaining + " " + t("minutesShort") : "");
    }

    function applyFilters() {
      const term = normalize(search.value.trim());
      const selectedRegion = region.value;
      const filtered = initiatives.filter((item) => {
        const haystack = normalize([
          item.name,
          item.city,
          item.region,
          item.country,
          item.domain,
          item.notes,
          ...getLocations(item).flatMap((location) => [
            location.name,
            location.address,
            location.notes,
            ...(location.openingSlots || []).map((slot) => slot.notes)
          ])
        ].join(" "));
        return (!term || haystack.includes(term)) && (!selectedRegion || item.region === selectedRegion);
      });
      renderList(filtered);
      noResults.style.display = filtered.length === 0 ? "block" : "none";
    }

    function showNearest(origin, label, options = {}) {
      routingGeneration += 1;
      nearestSortMode = "distance";
      currentOrigin = { ...origin, label };
      originRouteLabel = origin.label || "";
      rankedNearest = initiatives
        .map((item) => {
          const nearestLocation = getLocations(item)
            .filter((location) => location.coordinates)
            .map((location) => ({
              ...location,
              distance: distanceInKm(origin.lat, origin.lon, location.coordinates.lat, location.coordinates.lon)
            }))
            .sort((a, b) => a.distance - b.distance)[0];
          return nearestLocation ? {
            ...item,
            nearestLocation,
            distance: nearestLocation.distance,
            cityKey: cityRouteKey(item),
            routeState: { status: transitPreference === "enabled" ? "pending" : "disabled" }
          } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance);
      markRoutesPending();
      if (!options.preserveScroll) nearestVisibleCount = 5;
      renderNearest();
      routeVisibleInitiatives();
      nearestGrid.before(transitPreferences);
      renderTransitPreferences();

      results.hidden = false;
      locationStatus.textContent = t("statusSortedPrefix") + " " + label + ".";
      if (!options.preserveScroll) nearest.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    function renderNearest() {
      const visible = sortedVisibleInitiatives();
      nearestGrid.innerHTML = visible.map((item) => renderCard(item, item.distance, item.routeState)).join("");
      nearestCount.textContent = formatEntries(visible.length);
      updateNearestSortButton();
      loadMoreButton.hidden = nearestVisibleCount >= rankedNearest.length;
      if (map && currentOrigin) updateMap(visible, currentOrigin);
    }

    function sortedVisibleInitiatives() {
      const visible = rankedNearest.slice(0, nearestVisibleCount);
      if (nearestSortMode === "distance") return visible;
      return visible.sort((left, right) => {
        const leftDuration = transitSortDuration(left);
        const rightDuration = transitSortDuration(right);
        if (leftDuration !== rightDuration) return leftDuration - rightDuration;
        const leftFailed = left.routeState.status === "error";
        const rightFailed = right.routeState.status === "error";
        if (leftFailed !== rightFailed) return leftFailed ? 1 : -1;
        return left.distance - right.distance;
      });
    }

    function transitSortDuration(item) {
      if (item.routeState.status === "success") return item.routeState.duration;
      const originCity = normalizePlace(currentOrigin?.stationQuery || "");
      const destinationCity = normalizePlace(item.city || "");
      if (item.routeState.status === "error" && originCity && originCity === destinationCity) return 0;
      return Infinity;
    }

    function updateNearestSortButton() {
      sortNearestButton.hidden = transitPreference !== "enabled";
      if (transitPreference !== "enabled") {
        sortNearestButton.disabled = true;
        return;
      }
      const visible = rankedNearest.slice(0, nearestVisibleCount);
      const routingComplete = visible.length > 0 &&
        visible.every((item) => item.routeState.status === "success" || item.routeState.status === "error");
      sortNearestButton.disabled = !routingComplete;
      sortNearestButton.setAttribute("aria-pressed", String(nearestSortMode === "transit"));
      sortNearestButton.textContent = nearestSortMode === "transit"
        ? t("sortByDistance")
        : routingComplete
          ? t("sortByTransit")
          : t("sortByTransitLoading");
    }

    async function routeVisibleInitiatives() {
      if (transitPreference !== "enabled") return;
      const generation = routingGeneration;
      const visible = rankedNearest.slice(0, nearestVisibleCount);
      const pending = [...new Map(visible
        .filter((item) => item.routeState.status === "pending")
        .map((item) => [item.cityKey, item])).values()];
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < pending.length && generation === routingGeneration) {
          const item = pending[nextIndex++];
          setCityRouteState(item.cityKey, { status: "loading" });
          renderNearest();
          try {
            setCityRouteState(item.cityKey, { status: "success", ...await fetchCityTravelTime(item) });
          } catch {
            setCityRouteState(item.cityKey, { status: "error" });
          }
          renderNearest();
        }
      }

      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));
    }

    function setCityRouteState(cityKey, state) {
      for (const item of rankedNearest) {
        if (item.cityKey === cityKey) item.routeState = state;
      }
    }

    async function fetchCityTravelTime(item) {
      const fromStation = originRoutingPoint();
      const toStation = await resolveCityStation(item.city);
      if (!fromStation || !toStation) throw new Error("No city station");
      if (fromStation.id === toStation.id) {
        return { duration: 0, fromStation: fromStation.name, toStation: toStation.name };
      }
      const routeTime = representativeRouteTime();
      const cacheKey = transitCacheKey(fromStation, toStation, routeTime);
      const cached = readRouteCache(cacheKey);
      if (cached) return cached;

      const params = new URLSearchParams({
        fromPlace: fromStation.id,
        toPlace: toStation.id,
        time: routeTime.time.toISOString(),
        arriveBy: "false",
        timetableView: "false",
        numItineraries: "3",
        maxItineraries: "3",
        detailedLegs: "false",
        detailedTransfers: "false",
        language: currentLanguage
      });
      const response = await fetch(TRANSITOUS_URL + "?" + params);
      if (!response.ok) throw new Error("Transitous " + response.status);
      const data = await response.json();
      const candidates = (data.itineraries || [])
        .map(typicalTransitDuration)
        .filter((candidate) => Number.isFinite(candidate.duration) && candidate.duration >= 0);
      if (!candidates.length) throw new Error("No transit itinerary");
      const railCandidates = candidates.filter((candidate) => candidate.hasRail);
      const durations = (railCandidates.length ? railCandidates : candidates)
        .map((candidate) => candidate.duration);
      const result = {
        duration: Math.min(...durations),
        fromStation: fromStation.name,
        toStation: toStation.name
      };
      writeRouteCache(cacheKey, result, true);
      return result;
    }

    function originRoutingPoint() {
      if (!currentOrigin) return null;
      return {
        id: transitousOriginPlace(),
        name: originRouteLabel || currentOrigin.label || t("yourLocation")
      };
    }

    function typicalTransitDuration(itinerary) {
      const transitLegs = (itinerary.legs || []).filter((leg) => leg.mode !== "WALK");
      if (!transitLegs.length) return { duration: Number(itinerary.duration), hasRail: false };
      const start = new Date(transitLegs[0].startTime);
      const end = new Date(transitLegs[transitLegs.length - 1].endTime);
      const duration = (end - start) / 1000;
      return {
        duration: Number.isFinite(duration) && duration >= 0 ? duration : Number(itinerary.duration),
        hasRail: transitLegs.some((leg) => /RAIL|SUBURBAN/.test(leg.mode))
      };
    }

    function cityRouteKey(item) {
      return normalizePlace([item.city, item.region, item.country].filter(Boolean).join("|"));
    }

    function representativeRouteTime() {
      const now = new Date();
      for (let offset = 1; offset <= 7; offset += 1) {
        const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
        const parts = berlinDateParts(candidate);
        const weekday = isoWeekday(parts.year, parts.month, parts.day);
        if (weekday <= 5) {
          return { time: berlinLocalDate(parts.year, parts.month, parts.day, "10:00") };
        }
      }
      return { time: now };
    }

    async function resolveCityStation(city) {
      if (transitPreference !== "enabled") return null;
      const key = normalizePlace(city);
      if (!key) return null;
      if (cityStationCache.has(key)) return cityStationCache.get(key);
      const promise = fetchCityStation(city, key)
        .then((station) => {
          if (!station) cityStationCache.delete(key);
          return station;
        })
        .catch((error) => {
          cityStationCache.delete(key);
          throw error;
        });
      cityStationCache.set(key, promise);
      return promise;
    }

    async function fetchCityStation(city, cityKey) {
      const params = new URLSearchParams({ text: city + " Hauptbahnhof" });
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch("https://api.transitous.org/api/v1/geocode?" + params);
          if (response.ok) break;
          if (response.status !== 429 && response.status < 500) return null;
        } catch {
          // Retry transient network failures once.
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!response?.ok) return null;
      const results = await response.json();
      const matchingStops = results.filter((result) =>
        result.type === "STOP" && stationMatchesCity(result, cityKey)
      );
      const station =
        matchingStops.find((result) => /\\b(hauptbahnhof|hbf)\\b/i.test(result.name)) ||
        matchingStops.find((result) => /\\bbahnhof\\b/i.test(result.name)) ||
        matchingStops.find((result) => /\\b(zob|central bus station)\\b/i.test(result.name)) ||
        matchingStops[0];
      return station ? { id: station.id, name: station.name, lat: Number(station.lat), lon: Number(station.lon) } : null;
    }

    function stationMatchesCity(station, cityKey) {
      return normalizePlace(station.name).includes(cityKey) ||
        station.areas?.some((area) => normalizePlace(area.name) === cityKey);
    }

    function transitCacheKey(fromStation, toStation, routeTime) {
      const parts = berlinDateParts(routeTime.time);
      return ["city-v7", fromStation.id, toStation.id, parts.year, parts.month, parts.day].join("|");
    }

    function readRouteCache(key) {
      try {
        const cache = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY) || "{}");
        const entry = cache[key];
        if (!entry || entry.expiresAt <= Date.now()) return null;
        return entry.route;
      } catch {
        return null;
      }
    }

    function writeRouteCache(key, route, future) {
      try {
        const cache = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY) || "{}");
        const now = Date.now();
        for (const [entryKey, entry] of Object.entries(cache)) {
          if (!entry?.expiresAt || entry.expiresAt <= now) delete cache[entryKey];
        }
        cache[key] = {
          createdAt: now,
          expiresAt: now + (future ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000),
          route
        };
        const entries = Object.entries(cache).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 200);
        localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch {
        // Routing still works when storage is disabled or full.
      }
    }

    async function geocodePlaces(place) {
      const params = new URLSearchParams({
        q: place,
        format: "jsonv2",
        limit: "6",
        countrycodes: "de,at",
        addressdetails: "1",
        namedetails: "1"
      });
      let response;
      try {
        response = await fetch(GEOCODE_API_URL + "/search?" + params);
      } catch {
        const localMatch = findLocalPlace(place);
        if (localMatch) return [localMatch];
        throw new Error(t("statusPlaceError"));
      }
      if (!response.ok) {
        const localMatch = findLocalPlace(place);
        if (localMatch) return [localMatch];
        throw new Error(t("statusPlaceError"));
      }
      const results = await response.json();
      const places = results.map((result) => formatGeocodeResult(result, place))
        .filter((result, index, entries) =>
          entries.findIndex((entry) => entry.lat === result.lat && entry.lon === result.lon) === index);
      if (!places.length) {
        const localMatch = findLocalPlace(place);
        if (localMatch) return [localMatch];
        throw new Error(t("statusPlaceNotFound"));
      }
      return places;
    }

    function formatGeocodeResult(result, fallback) {
      const address = result.address || {};
      const placeName = result.namedetails?.name ||
        result.name ||
        address.village ||
        address.town ||
        address.city ||
        address.suburb ||
        address.municipality ||
        fallback;
      const postcode = address.postcode || "";
      const state = address.state || "";
      const nearby = [
        address.city,
        address.town,
        address.municipality,
        address.county
      ].find((value) => value && normalizePlace(value) !== normalizePlace(placeName)) || "";
      return {
        lat: Number(result.lat),
        lon: Number(result.lon),
        label: [placeName, postcode].filter(Boolean).join(" "),
        detail: [state, nearby].filter(Boolean).join(" · "),
        stationQuery: address.city ||
          address.town ||
          address.village ||
          address.municipality ||
          postcode ||
          fallback
      };
    }

    function renderPlaceSuggestions(places) {
      placeSuggestions.currentPlaces = places;
      placeSuggestions.innerHTML = places.map((place, index) =>
        '<li><button type="button" data-place-index="' + index + '">' +
        escapeHtml(place.label) +
        (place.detail ? '<small>' + escapeHtml(place.detail) + '</small>' : "") +
        '</button></li>'
      ).join("");
      placeSuggestions.hidden = false;
      placeSuggestions.querySelector("button")?.focus();
    }

    function clearPlaceSuggestions() {
      placeSuggestions.hidden = true;
      placeSuggestions.innerHTML = "";
      placeSuggestions.currentPlaces = null;
    }

    async function selectPlace(query, place) {
      clearPlaceSuggestions();
      locationInput.value = place.label;
      setStatus("statusSearchingPlace");
      const origin = await preferCentralStation(query, place);
      showNearest(origin, place.label);
    }

    async function preferCentralStation(place, fallback) {
      if (transitPreference !== "enabled") return fallback;
      if (looksLikeFullAddress(place)) return fallback;
      try {
        const city = fallback.stationQuery || fallback.label || place;
        const station = await resolveCityStation(city);
        if (!station) return fallback;
        return {
          lat: Number(station.lat),
          lon: Number(station.lon),
          label: station.name,
          stationQuery: city,
          transitousPlace: station.id
        };
      } catch {
        return fallback;
      }
    }

    function looksLikeFullAddress(value) {
      const input = String(value).trim();
      const withoutPostcode = input.replace(/\\b\\d{5}\\b/, "");
      const hasHouseNumber = /\\b\\d+[a-z]?\\b/i.test(withoutPostcode);
      const hasStreet = /\\b(stra(?:ße|sse|ss|ße)|str\\.?|weg|allee|platz|gasse|ufer|chaussee|damm|ring)\\b/i.test(input);
      return hasHouseNumber && hasStreet;
    }

    function transitousOriginPlace() {
      return currentOrigin.transitousPlace || currentOrigin.lat + "," + currentOrigin.lon;
    }

    async function resolveOriginLabel(origin) {
      const key = origin.lat.toFixed(4) + "," + origin.lon.toFixed(4);
      try {
        if (reverseGeocodeCache.has(key)) {
          const cached = reverseGeocodeCache.get(key);
          originRouteLabel = cached.label;
          currentOrigin.stationQuery = cached.city || "";
          retryCityRouting();
          renderNearest();
          return;
        }
        const params = new URLSearchParams({
          lat: origin.lat,
          lon: origin.lon,
          format: "jsonv2",
          zoom: "16",
          addressdetails: "1"
        });
        const response = await fetch(GEOCODE_API_URL + "/reverse?" + params);
        if (!response.ok) return;
        const result = await response.json();
        const label = result.display_name?.split(",").slice(0, 3).join(", ").trim();
        if (!label) return;
        originRouteLabel = label;
        const city = result.address?.city ||
          result.address?.town ||
          result.address?.village ||
          result.address?.municipality ||
          "";
        currentOrigin.stationQuery = city;
        reverseGeocodeCache.set(key, { label, city });
        retryCityRouting();
        renderNearest();
      } catch {
        // Coordinates keep the Transitous link usable without reverse geocoding.
      }
    }

    function retryCityRouting() {
      if (transitPreference !== "enabled") return;
      if (!currentOrigin.stationQuery) return;
      for (const item of rankedNearest.slice(0, nearestVisibleCount)) {
        if (item.routeState.status === "error") item.routeState = { status: "pending" };
      }
      routeVisibleInitiatives();
    }

    function buildTransitousUrl(item, location) {
      const destination = [location.name, location.address].filter(Boolean).join(" · ") ||
        location.coordinates?.label ||
        item.city ||
        item.name;
      const routeTime = routeTimeForLocation(location);
      const params = new URLSearchParams({
        fromPlace: transitousOriginPlace(),
        toPlace: location.coordinates.lat + "," + location.coordinates.lon,
        fromName: originRouteLabel || currentOrigin.label || t("yourLocation"),
        toName: destination,
        time: formatTransitousDateTime(routeTime.time),
        arriveBy: String(routeTime.arriveBy)
      });
      return "https://api.transitous.org?" + params;
    }

    function routeTimeForLocation(location) {
      const now = new Date();
      const slots = location.openingSlots || [];
      if (!slots.length) return { time: now, arriveBy: false };
      const current = berlinDateParts(now);
      for (const slot of slots) {
        const interval = slotInterval(current, slot);
        if (interval && now >= interval.start && now < interval.end) {
          return { time: now, arriveBy: false };
        }
      }
      for (let offset = 0; offset <= 56; offset += 1) {
        const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
        const parts = berlinDateParts(candidate);
        const nextInterval = slots
          .map((slot) => slotInterval(parts, slot))
          .filter((interval) => interval?.start > now)
          .sort((left, right) => left.start - right.start)[0];
        if (nextInterval) {
          return { time: new Date(nextInterval.start.getTime() - 10 * 60 * 1000), arriveBy: true };
        }
      }
      return { time: now, arriveBy: false };
    }

    function slotInterval(parts, slot) {
      const weekday = isoWeekday(parts.year, parts.month, parts.day);
      const weekOfMonth = Math.ceil(parts.day / 7);
      if (!slot.weekdays.includes(weekday)) return null;
      if (slot.weeksOfMonth?.length && !slot.weeksOfMonth.includes(weekOfMonth)) return null;
      return {
        start: berlinLocalDate(parts.year, parts.month, parts.day, slot.start),
        end: berlinLocalDate(parts.year, parts.month, parts.day, slot.end)
      };
    }

    function berlinDateParts(date) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: BERLIN_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
      return { year: values.year, month: values.month, day: values.day };
    }

    function berlinLocalDate(year, month, day, time) {
      const [hour, minute] = time.split(":").map(Number);
      const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: BERLIN_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(guess);
      const local = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
      const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
      return new Date(guess.getTime() - (represented - guess.getTime()));
    }

    function isoWeekday(year, month, day) {
      const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      return dayOfWeek === 0 ? 7 : dayOfWeek;
    }

    function formatTransitousDateTime(date) {
      const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: BERLIN_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(date);
      const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return value.year + "-" + value.month + "-" + value.day + "T" + value.hour + ":" + value.minute;
    }

    function findLocalPlace(place) {
      const query = normalizePlace(place);
      if (!query) return null;

      const exactMatch = initiatives.find((item) => {
        if (!getLocations(item).some((location) => location.coordinates)) return false;
        return localPlaceKeys(item).some((key) => normalizePlace(key) === query);
      });
      if (exactMatch) return localOrigin(exactMatch);

      const partialMatch = initiatives.find((item) => {
        if (query.length < 4 || !getLocations(item).some((location) => location.coordinates)) return false;
        return localPlaceKeys(item).some((key) => normalizePlace(key).includes(query));
      });
      return partialMatch ? localOrigin(partialMatch) : null;
    }

    function localPlaceKeys(item) {
      return [
        item.name,
        item.city,
        item.region,
        ...getLocations(item).flatMap((location) => [location.name, location.address, location.coordinates?.label]),
        ...(item.aliases || [])
      ].filter(Boolean);
    }

    function localOrigin(item) {
      const location = getLocations(item).find((entry) => entry.coordinates);
      if (!location) return null;
      return {
        lat: location.coordinates.lat,
        lon: location.coordinates.lon,
        label: item.city || item.name,
        stationQuery: item.city || item.name
      };
    }

    function getLocations(item) {
      if (item.locations?.length) return item.locations;
      return item.coordinates ? [{ name: "", address: item.address || "", openingSlots: [], notes: "", coordinates: item.coordinates }] : [];
    }

    async function enableMap() {
      mapStatus.textContent = t("mapLoading");
      await loadLeaflet();
      mapElement.style.display = "block";
      const origin = currentOrigin;
      if (!map) {
        map = L.map(mapElement, { scrollWheelZoom: false });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors"
        }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        originLayer = L.layerGroup().addTo(map);
      }
      updateMap(origin ? null : initiatives.slice(0, 200), origin);
      mapStatus.textContent = t("mapReady");
      setTimeout(() => {
        map.invalidateSize();
        if (origin) map.setView([origin.lat, origin.lon], 12);
      }, 0);
    }

    function updateMap(items, origin) {
      if (!map) return;
      const visible = items ?? initiatives
        .filter((item) => getLocations(item).some((location) => location.coordinates))
        .map((item) => currentOrigin ? {
          ...item,
          distance: Math.min(...getLocations(item)
            .filter((location) => location.coordinates)
            .map((location) => distanceInKm(currentOrigin.lat, currentOrigin.lon, location.coordinates.lat, location.coordinates.lon)))
        } : item)
        .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
        .slice(0, currentOrigin ? 80 : 200);
      markerLayer.clearLayers();
      originLayer.clearLayers();
      const bounds = [];
      for (const item of visible) {
        for (const location of getLocations(item)) {
          if (!location.coordinates) continue;
          const latLng = [location.coordinates.lat, location.coordinates.lon];
          bounds.push(latLng);
          L.marker(latLng).addTo(markerLayer).bindPopup(renderPopup(item, location));
        }
      }
      if (origin) {
        const originLatLng = [origin.lat, origin.lon];
        bounds.push(originLatLng);
        L.circleMarker(originLatLng, { radius: 8, color: "#0f6760", fillOpacity: 0.8 }).addTo(originLayer).bindPopup(t("yourLocation"));
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    }

    function renderPopup(item, location) {
      const locationLabel = location.coordinates?.label || location.address || [item.city, item.region].filter(Boolean).join(" · ");
      const openingHours = formatOpeningSlots(location.openingSlots);
      return '<strong>' + escapeHtml(item.name) + '</strong><br>' +
        (location.name ? escapeHtml(location.name) + '<br>' : "") +
        escapeHtml(locationLabel) +
        (openingHours.length ? '<br><br><strong>' + escapeHtml(t("openingHoursLabel")) + '</strong><br>' +
          openingHours.map((row) => escapeHtml(row.schedule) + (row.notes ? '<br><small>' + escapeHtml(row.notes) + '</small>' : "")).join("<br>") : "") +
        (location.notes ? '<br><br><strong>' + escapeHtml(t("notesLabel")) + '</strong><br>' + escapeHtml(location.notes) : "") +
        (item.url ? '<br><a href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">' + t("website") + '</a>' : "");
    }

    function loadLeaflet() {
      if (window.L) return Promise.resolve();
      if (leafletLoading) return leafletLoading;
      leafletLoading = new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "assets/leaflet/leaflet.css";
        document.head.append(link);
        const script = document.createElement("script");
        script.src = "assets/leaflet/leaflet.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      });
      return leafletLoading;
    }

    function formatEntries(count) {
      return count === 1 ? t("oneEntry") : count + " " + t("entries");
    }

    function groupBy(items, keyFn) {
      const map = new Map();
      for (const item of items) {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
      }
      return map;
    }

    function normalize(value) {
      return value.toLocaleLowerCase(currentLanguage === "de" ? "de-DE" : undefined);
    }

    function normalizePlace(value) {
      return String(value)
        .normalize("NFKD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLocaleLowerCase("de-DE")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function distanceInKm(lat1, lon1, lat2, lon2) {
      const radius = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
      return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function toRad(value) {
      return value * Math.PI / 180;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
  </script>
</body>
</html>
`;
}

function toPageInitiatives(initiatives) {
  return initiatives.map(({ sources, websiteCheck, ...item }) => item);
}

function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      output[key] = deepMerge(output[key] ?? {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function compareInitiatives(a, b) {
  return a.country.localeCompare(b.country, "de") ||
    a.region.localeCompare(b.region, "de") ||
    a.name.localeCompare(b.name, "de");
}

function normalizeCountry(value) {
  if (value === "Germany") return "Deutschland";
  if (value === "Austria") return "Österreich";
  return value;
}

function normalizeLocationName(value) {
  return value
    .replace(/\s*-\s*Landkreis$/i, "")
    .replace(/\s+Süd$/i, "")
    .replace(/^Berlin\/Brandenburg$/i, "Berlin")
    .trim();
}

function normalizeComparable(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-DE")
    .trim();
}

function cleanText(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[entity.toLowerCase()] ?? _;
  });
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

const report = {
  startedAt: new Date(),
  summary: null,
  changes: null,
  websiteFailures: [],
  websiteTransitions: [],
  warnings: [],
  error: ""
};

try {
  await main(report);
} catch (error) {
  report.error = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await writeRunLog(report);
  } catch (error) {
    console.error("Failed to write update log:", error);
    process.exitCode = 1;
  }
}
