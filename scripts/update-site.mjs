import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const SOURCE_URL = "https://www.seebruecke.org/aktuelles/kampagnen/bezahlkarte";
const GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
const GEOCODE_CACHE_VERSION = "v3";
const WEBSITE_CHECK_TIMEOUT_MS = 10000;
const WEBSITE_CHECK_CONCURRENCY = 4;
const DATA_PATH = new URL("../data/initiatives.json", import.meta.url);
const CATALOG_PATH = new URL("../data/catalog.yml", import.meta.url);
const I18N_DIR = new URL("../data/i18n/", import.meta.url);
const OPENING_HOURS_I18N_PATH = new URL("../data/opening-hours-i18n.json", import.meta.url);
const GEOCODE_CACHE_PATH = new URL("../data/geocodes.json", import.meta.url);
const INDEX_PATH = new URL("../index.html", import.meta.url);
const LEAFLET_DIST = new URL("../node_modules/leaflet/dist/", import.meta.url);
const LEAFLET_ASSETS = new URL("../assets/leaflet/", import.meta.url);

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

async function main() {
  const [html, catalog, translations, openingHoursTranslations, geocodeCache] = await Promise.all([
    fetchSource(),
    readCatalog(),
    readTranslations(),
    readOpeningHoursTranslations(),
    readGeocodeCache()
  ]);
  const scraped = parseInitiatives(html);
  const initiatives = mergeInitiatives(scraped, catalog);
  addOpeningHoursKeys(initiatives);
  const validOpeningHoursTranslations = normalizeOpeningHoursTranslations(initiatives, openingHoursTranslations);

  if (scraped.length < 20) {
    throw new Error(`Parsed only ${scraped.length} initiatives; source structure may have changed.`);
  }

  validateInitiatives(initiatives);
  await addCoordinates(initiatives, geocodeCache);
  await checkInitiativeWebsites(initiatives);
  initiatives.sort(compareInitiatives);

  const data = {
    sourceUrl: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    languages: LANGUAGES,
    initiatives
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await copyLeafletAssets();
  await writeFile(GEOCODE_CACHE_PATH, `${JSON.stringify(geocodeCache, null, 2)}\n`);
  await writeFile(OPENING_HOURS_I18N_PATH, `${JSON.stringify(validOpeningHoursTranslations, null, 2)}\n`);
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(INDEX_PATH, renderPage(data, translations, validOpeningHoursTranslations));

  console.log(`Updated ${initiatives.length} initiatives (${scraped.length} scraped, ${catalog.initiatives.length} curated).`);
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

async function readOpeningHoursTranslations() {
  try {
    return JSON.parse(await readFile(OPENING_HOURS_I18N_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
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

function mergeInitiatives(scraped, catalog) {
  const byId = new Map(scraped.map((item) => [item.id, item]));
  const scrapedIds = new Set(byId.keys());

  for (const rawOverride of catalog.overrides) {
    const { match, ...fields } = rawOverride ?? {};
    const existing = findInitiative(byId, match);
    if (!existing) {
      console.warn(`No initiative matched override: ${JSON.stringify(match)}`);
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
      openingHours: String(location?.openingHours ?? "").trim(),
      openingSlots: normalizeOpeningSlots(location?.openingSlots),
      coordinates: normalizeCoordinates(location?.coordinates)
    }))
    .filter((location) => location.name || location.address || location.openingHours || location.openingSlots.length || location.coordinates);
}

function normalizeOpeningSlots(value) {
  if (!Array.isArray(value)) return [];
  return value.map((slot) => ({
    weekdays: Array.isArray(slot?.weekdays) ? slot.weekdays.map(Number) : [],
    weeksOfMonth: Array.isArray(slot?.weeksOfMonth) ? slot.weeksOfMonth.map(Number) : [],
    start: String(slot?.start ?? "").trim(),
    end: String(slot?.end ?? "").trim()
  }));
}

function addOpeningHoursKeys(initiatives) {
  for (const initiative of initiatives) {
    for (const location of initiative.locations) {
      if (!location.openingHours) continue;
      location.openingHoursKey = [
        openingHoursKeyPart(initiative.id),
        openingHoursKeyPart(location.name || "location"),
        openingHoursKeyPart(location.address || "no-address")
      ].join("|");
    }
  }
}

function openingHoursKeyPart(value) {
  return slugify(String(value).replaceAll("ß", "ss"));
}

function normalizeOpeningHoursTranslations(initiatives, values) {
  const sources = new Map(initiatives.flatMap((initiative) =>
    initiative.locations
      .filter((location) => location.openingHoursKey)
      .map((location) => [location.openingHoursKey, location.openingHours])
  ));
  return Object.fromEntries(Object.entries(values ?? {}).flatMap(([key, entry]) => {
    const source = sources.get(key);
    if (!source || entry?.source !== source) return [];
    const translations = Object.fromEntries(Object.entries(entry.translations ?? {})
      .filter(([code, text]) => LANGUAGES.some((language) => language.code === code) && String(text).trim())
      .map(([code, text]) => [code, String(text).trim()]));
    return Object.keys(translations).length ? [[key, { source, translations }]] : [];
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
      if (/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/i.test(location.openingHours)) {
        throw new Error(`Opening hours must use 24-hour HH:MM format in catalog data: ${item.id}`);
      }
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
      initiative.locations.push({ name: "", address: "", openingHours: "", openingSlots: [], coordinates: initiative.coordinates });
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

async function checkInitiativeWebsites(initiatives) {
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
    if (initiative.websiteCheck && !initiative.websiteCheck.ok) failed += 1;
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
  const response = await fetch(`${GEOCODE_URL}?${params}`, {
    headers: {
      "user-agent": "Anti-SocialCard.de updater; static initiative directory"
    }
  });
  if (!response.ok) return null;
  const [result] = await response.json();
  return result ?? null;
}

function renderPage(data, translations, openingHoursTranslations) {
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
  <title>Anti-SocialCard.de</title>
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
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    #nearest-grid > .initiative:last-child:nth-child(odd) {
      grid-column: 1 / -1;
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

    .distance { color: var(--accent); font-weight: 760; }

    .journey {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--paper);
    }

    .journey-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      color: var(--ink);
      font-size: 0.88rem;
      font-weight: 680;
    }

    .journey-status {
      color: var(--muted);
      font-size: 0.86rem;
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
      .language-switcher button { width: auto; }
      #map { min-height: 340px; }
      .grid, #nearest-grid { grid-template-columns: 1fr; }
      #nearest-grid > .initiative:last-child:nth-child(odd) { grid-column: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap hero">
      <div class="topline">
        <p class="brand">Anti-SocialCard.de</p>
        <nav class="language-switcher" id="language-switcher" aria-label="Language"></nav>
      </div>
      <h1 data-i18n="title">Initiativen gegen die Bezahlkarte</h1>
      <p class="intro" data-i18n="intro">Eine Übersicht lokaler Gruppen und Tauschaktionen.</p>
      <form class="quick-start" id="locator">
        <label>
          <span data-i18n="locationLabel">Dein Ort</span>
          <input id="location" autocomplete="off" data-i18n-placeholder="locationPlaceholder">
        </label>
        <button type="submit" data-i18n="findNearest">Nächste finden</button>
        <button class="secondary" type="button" id="use-location" data-i18n="useLocation">Standort nutzen</button>
      </form>
    </div>
  </header>

  <main class="wrap">
    <p class="status" id="location-status" role="status" aria-live="polite" data-i18n="statusDefault"></p>

    <div id="results" hidden>
      <section class="section" id="nearest" aria-live="polite">
        <div class="section-head">
          <h2 data-i18n="nearestTitle">Nächste Initiativen</h2>
          <span class="count" id="nearest-count"></span>
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
      <a href="https://github.com/Bobylein/anti-socialcard" target="_blank" rel="noopener noreferrer" data-i18n="contactLink">Kontakt und Quellcode.</a>
    </div>
  </footer>

  <script type="application/json" id="initiative-data">${escapeScriptJson(toPageInitiatives(data.initiatives))}</script>
  <script type="application/json" id="translation-data">${escapeScriptJson(translations)}</script>
  <script type="application/json" id="opening-hours-translation-data">${escapeScriptJson(openingHoursTranslations)}</script>
  <script type="application/json" id="language-data">${escapeScriptJson(LANGUAGES)}</script>
  <script>
    const initiatives = JSON.parse(document.getElementById("initiative-data").textContent);
    const translations = JSON.parse(document.getElementById("translation-data").textContent);
    const openingHoursTranslations = JSON.parse(document.getElementById("opening-hours-translation-data").textContent);
    const languages = JSON.parse(document.getElementById("language-data").textContent);
    const languageSwitcher = document.getElementById("language-switcher");
    const locator = document.getElementById("locator");
    const locationInput = document.getElementById("location");
    const useLocation = document.getElementById("use-location");
    const locationStatus = document.getElementById("location-status");
    const results = document.getElementById("results");
    const nearest = document.getElementById("nearest");
    const nearestGrid = document.getElementById("nearest-grid");
    const nearestCount = document.getElementById("nearest-count");
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
    const TRANSITOUS_URL = "https://api.transitous.org/api/v6/plan";
    const ROUTE_CACHE_KEY = "anti-socialcard-transitous-city-v4";
    const REVERSE_GEOCODE_CACHE_KEY = "anti-socialcard-origin-labels-v1";
    const BERLIN_TIME_ZONE = "Europe/Berlin";
    let currentLanguage = chooseInitialLanguage();
    let currentOrigin = null;
    let originRouteLabel = "";
    let map = null;
    let markerLayer = null;
    let originLayer = null;
    let leafletLoading = null;
    let locationRequestPending = false;
    let rankedNearest = [];
    let nearestVisibleCount = 10;
    let routingGeneration = 0;
    const cityStationCache = new Map();

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
        renderNearest();
        routeVisibleInitiatives();
      });
      locator.addEventListener("submit", async (event) => {
        event.preventDefault();
        const place = locationInput.value.trim();
        if (!place) return;
        setStatus("statusSearchingPlace");
        try {
          const origin = await geocodePlace(place);
          showNearest(origin, origin.label);
        } catch (error) {
          locationStatus.textContent = error.message;
        }
      });
      useLocation.addEventListener("click", () => {
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
      const requested = params.get("lang") || localStorage.getItem("language") || navigator.language.slice(0, 2);
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
      localStorage.setItem("language", currentLanguage);
      document.querySelectorAll("[data-i18n]").forEach((element) => {
        element.textContent = t(element.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
        element.placeholder = t(element.dataset.i18nPlaceholder);
      });
      languageSwitcher.querySelectorAll("button").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.lang === currentLanguage));
      });
      applyFilters();
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
      const distanceText = Number.isFinite(distance) ? '<span class="distance">' + Math.round(distance) + ' ' + t("distanceKm") + '</span> · ' : "";
      const title = item.city || item.name;
      const initiativeName = item.city ? '<p class="initiative-name">' + escapeHtml(item.name) + '</p>' : "";
      const locations = getLocations(item).map((location) => renderLocationDetails(location, Number.isFinite(distance) ? item : null)).filter(Boolean).join("");
      const locationDetails = locations ? '<div class="locations">' + locations + '</div>' : "";
      const journey = Number.isFinite(distance) ? renderJourney(routeState) : "";
      const updatedAt = item.updatedAt ? '<span class="updated-at">' + escapeHtml(t("updatedLabel") + ": " + formatDate(item.updatedAt)) + '</span>' : "";
      return '<article class="initiative" data-id="' + escapeHtml(item.id) + '">' +
        '<div><h3>' + escapeHtml(title) + '</h3>' + initiativeName + locationDetails + '<p>' + distanceText + escapeHtml([item.region, item.country].filter(Boolean).join(" · ")) + '</p></div>' + journey +
        '<div class="card-footer"><div class="links">' + links.join("") + '</div>' + updatedAt + '</div>' +
        '</article>';
    }

    function renderJourney(routeState) {
      if (!routeState || routeState.status === "pending") {
        return '<div class="journey"><span class="journey-status">' + escapeHtml(t("transitWaiting")) + '</span></div>';
      }
      if (routeState.status === "loading") {
        return '<div class="journey"><span class="journey-status">' + escapeHtml(t("transitLoading")) + '</span></div>';
      }
      if (routeState.status === "error") {
        return '<div class="journey"><span class="journey-status">' + escapeHtml(t("transitUnavailable")) + '</span></div>';
      }
      return '<div class="journey"><div class="journey-summary"><span>' +
        escapeHtml(t("cityTravelTime") + ": " + formatDuration(routeState.duration)) +
        '</span></div><span class="journey-status">' +
        escapeHtml(routeState.fromStation + " → " + routeState.toStation) +
        '</span></div>';
    }

    function renderLocationDetails(location, item) {
      const title = [location.name, location.address].filter(Boolean).join(" · ");
      const openingHourRows = formatOpeningHours(translatedOpeningHours(location));
      const openingHours = openingHourRows.length
        ? '<div class="opening-hours"><span class="opening-hours-label">' + escapeHtml(t("openingHoursLabel")) + '</span><span class="opening-hours-value">' +
          openingHourRows.map((row) => '<span class="opening-hours-row">' + escapeHtml(row) + '</span>').join("") + '</span></div>'
        : "";
      const routeLink = item && location.coordinates
        ? '<div class="links"><a class="transitous-link" href="' + escapeHtml(buildTransitousUrl(item, location)) +
          '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t("transitousRoute")) + '</a></div>'
        : "";
      if (!title && !openingHours && !routeLink) return "";
      return '<div class="location"><p class="location-name">' + escapeHtml(title) + '</p>' +
        openingHours + routeLink + '</div>';
    }

    function formatOpeningHours(value) {
      if (!value) return [];
      return value.split(/[;\\n]+/).map((row) => row.trim()).filter(Boolean).map((row) => {
        const ranges = [];
        const withRangePlaceholders = row.replace(
          /\\b([01]?\\d|2[0-3]):([0-5]\\d)\\s*[–—-]\\s*([01]?\\d|2[0-3]):([0-5]\\d)\\b/g,
          (_, startHour, startMinute, endHour, endMinute) => {
            ranges.push(formatTimeRange(Number(startHour), Number(startMinute), Number(endHour), Number(endMinute)));
            return "__OPENING_HOURS_RANGE_" + (ranges.length - 1) + "__";
          }
        );
        const withTimes = withRangePlaceholders.replace(
          /\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b/g,
          (_, hour, minute) => formatTime(Number(hour), Number(minute))
        );
        return withTimes.replace(/__OPENING_HOURS_RANGE_(\\d+)__/g, (_, index) => ranges[Number(index)]);
      });
    }

    function translatedOpeningHours(location) {
      const entry = openingHoursTranslations[location.openingHoursKey];
      return entry?.source === location.openingHours && entry.translations?.[currentLanguage]
        ? entry.translations[currentLanguage]
        : location.openingHours;
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
        const haystack = normalize([item.name, item.city, item.region, item.country, item.domain, ...getLocations(item).flatMap((location) => [location.name, location.address, translatedOpeningHours(location)])].join(" "));
        return (!term || haystack.includes(term)) && (!selectedRegion || item.region === selectedRegion);
      });
      renderList(filtered);
      noResults.style.display = filtered.length === 0 ? "block" : "none";
    }

    function showNearest(origin, label, options = {}) {
      routingGeneration += 1;
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
            routeState: { status: "pending" }
          } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance);
      if (!options.preserveScroll) nearestVisibleCount = 10;
      renderNearest();
      routeVisibleInitiatives();

      results.hidden = false;
      locationStatus.textContent = t("statusSortedPrefix") + " " + label + ".";
      if (!options.preserveScroll) nearest.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    function renderNearest() {
      const visible = sortedVisibleInitiatives();
      nearestGrid.innerHTML = visible.map((item) => renderCard(item, item.distance, item.routeState)).join("");
      nearestCount.textContent = formatEntries(visible.length);
      loadMoreButton.hidden = nearestVisibleCount >= rankedNearest.length;
      if (map && currentOrigin) updateMap(visible, currentOrigin);
    }

    function sortedVisibleInitiatives() {
      return rankedNearest.slice(0, nearestVisibleCount).sort((left, right) => {
        const leftDuration = left.routeState.status === "success" ? left.routeState.duration : Infinity;
        const rightDuration = right.routeState.status === "success" ? right.routeState.duration : Infinity;
        if (leftDuration !== rightDuration) return leftDuration - rightDuration;
        const leftFailed = left.routeState.status === "error";
        const rightFailed = right.routeState.status === "error";
        if (leftFailed !== rightFailed) return leftFailed ? 1 : -1;
        return left.distance - right.distance;
      });
    }

    async function routeVisibleInitiatives() {
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
      const [fromStation, toStation] = await Promise.all([
        resolveCityStation(currentOrigin.stationQuery || currentOrigin.label),
        resolveCityStation(item.city)
      ]);
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
        directModes: "",
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
      const key = normalizePlace(city);
      if (!key) return null;
      if (cityStationCache.has(key)) return cityStationCache.get(key);
      const promise = fetchCityStation(city, key);
      cityStationCache.set(key, promise);
      return promise;
    }

    async function fetchCityStation(city, cityKey) {
      const params = new URLSearchParams({ text: city + " Hauptbahnhof" });
      const response = await fetch("https://api.transitous.org/api/v1/geocode?" + params);
      if (!response.ok) return null;
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
      return ["city-v4", fromStation.id, toStation.id, parts.year, parts.month, parts.day].join("|");
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

    async function geocodePlace(place) {
      const localMatch = findLocalPlace(place);
      if (localMatch) return preferCentralStation(place, localMatch);

      const params = new URLSearchParams({
        q: place,
        format: "jsonv2",
        limit: "1",
        countrycodes: "de,at",
        addressdetails: "1"
      });
      const response = await fetch("https://nominatim.openstreetmap.org/search?" + params);
      if (!response.ok) throw new Error(t("statusPlaceError"));
      const [result] = await response.json();
      if (!result) throw new Error(t("statusPlaceNotFound"));
      const origin = {
        lat: Number(result.lat),
        lon: Number(result.lon),
        label: result.display_name.split(",").slice(0, 2).join(", "),
        stationQuery: result.address?.city ||
          result.address?.town ||
          result.address?.village ||
          result.address?.municipality ||
          result.address?.postcode ||
          place
      };
      return preferCentralStation(place, origin);
    }

    async function preferCentralStation(place, fallback) {
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
        const cache = JSON.parse(localStorage.getItem(REVERSE_GEOCODE_CACHE_KEY) || "{}");
        if (cache[key]) {
          const cached = typeof cache[key] === "string" ? { label: cache[key], city: "" } : cache[key];
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
        const response = await fetch("https://nominatim.openstreetmap.org/reverse?" + params);
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
        cache[key] = { label, city };
        localStorage.setItem(REVERSE_GEOCODE_CACHE_KEY, JSON.stringify(cache));
        retryCityRouting();
        renderNearest();
      } catch {
        // Coordinates keep the Transitous link usable without reverse geocoding.
      }
    }

    function retryCityRouting() {
      if (!currentOrigin.stationQuery) return;
      for (const item of rankedNearest) {
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
      return item.coordinates ? [{ name: "", address: item.address || "", openingHours: "", openingSlots: [], coordinates: item.coordinates }] : [];
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
      const openingHours = formatOpeningHours(translatedOpeningHours(location));
      return '<strong>' + escapeHtml(item.name) + '</strong><br>' +
        (location.name ? escapeHtml(location.name) + '<br>' : "") +
        escapeHtml(locationLabel) +
        (openingHours.length ? '<br><br><strong>' + escapeHtml(t("openingHoursLabel")) + '</strong><br>' + openingHours.map(escapeHtml).join("<br>") : "") +
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
