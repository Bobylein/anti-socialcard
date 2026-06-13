import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  emptyGroupReport,
  mergeGroupInitiatives,
  readGroupCache,
  syncGroupData,
  writeGroupCache
} from "./group-data.mjs";
import { loadEnvFile } from "./load-env.mjs";
import { fetchPublicWebsite, normalizeHttpUrl } from "./url-security.mjs";

const SOURCE_URL = "https://www.seebruecke.org/aktuelles/kampagnen/bezahlkarte";
const BUILD_GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
const GEOCODE_CACHE_VERSION = "v3";
const WEBSITE_CHECK_TIMEOUT_MS = 10000;
const WEBSITE_CHECK_CONCURRENCY = 4;
const DATA_PATH = new URL("../data/initiatives.json", import.meta.url);
const GROUP_CACHE_PATH = new URL("../data/group-cache.json", import.meta.url);
const I18N_DIR = new URL("../data/i18n/", import.meta.url);
const GEOCODE_CACHE_PATH = new URL("../data/geocodes.json", import.meta.url);
const INDEX_PATH = new URL("../index.html", import.meta.url);
const LOGS_DIR = new URL("../logs/", import.meta.url);
const LEAFLET_DIST = new URL("../node_modules/leaflet/dist/", import.meta.url);
const LEAFLET_ASSETS = new URL("../assets/leaflet/", import.meta.url);
const BROWSER_SOURCE = new URL("../src/browser/", import.meta.url);
const BROWSER_ASSETS = new URL("../assets/", import.meta.url);
const COMPARED_INITIATIVE_FIELDS = [
  "name",
  "city",
  "region",
  "country",
  "address",
  "url",
  "coordinates",
  "locations",
  "events",
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
  const [html, translations, geocodeCache, previousData, groupCache] = await Promise.all([
    fetchSource(),
    readTranslations(),
    readGeocodeCache(),
    readPreviousData(),
    readGroupCache(GROUP_CACHE_PATH)
  ]);
  const scraped = parseInitiatives(html);
  const groupSync = await syncGroupData({
    cache: groupCache,
    allowFallback: process.env.ALLOW_GROUP_CACHE_FALLBACK === "true"
  });
  const initiatives = mergeGroupInitiatives(scraped, groupSync.entries).map(normalizeInitiative);
  report.groups = groupSync.report;
  report.warnings.push(...groupSync.report.warnings);

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
    managed: Object.keys(groupSync.entries).length
  };
  report.changes = compareDatasets(previousData, data);
  report.websiteTransitions = compareWebsiteChecks(previousData, data);

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await copyBrowserAssets();
  await copyLeafletAssets();
  await writeGroupCache(GROUP_CACHE_PATH, groupSync.cache);
  await writeFile(GEOCODE_CACHE_PATH, `${JSON.stringify(geocodeCache, null, 2)}\n`);
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(INDEX_PATH, renderPage(data, translations));

  console.log(`Updated ${initiatives.length} initiatives (${scraped.length} scraped, ${report.summary.managed} managed).`);
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

async function copyBrowserAssets() {
  await mkdir(BROWSER_ASSETS, { recursive: true });
  await Promise.all([
    cp(new URL("site.css", BROWSER_SOURCE), new URL("site.css", BROWSER_ASSETS)),
    cp(new URL("site.js", BROWSER_SOURCE), new URL("site.js", BROWSER_ASSETS))
  ]);
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
    const url = link
      ? normalizeHttpUrl(decodeHtml(link[1]), { baseUrl: SOURCE_URL, path: `Initiative ${title}` })
      : "";
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

function normalizeInitiative(raw) {
  const url = raw.url ? normalizeHttpUrl(raw.url, { path: "Initiative website" }) : "";
  const country = raw.country ? String(raw.country) : "Deutschland";
  const region = raw.region ?? raw.state ?? (country === "Deutschland" ? "Bundesweit" : country);
  const city = raw.city ?? raw.name;
  const sources = normalizeLinks(raw.sources);
  const transitLinks = normalizeLinks(raw.transitLinks);
  const locations = normalizeLocations(raw);
  const events = normalizeEvents(raw.events);

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
    events,
    notes: String(raw.notes ?? "").trim(),
    transitLinks,
    sources,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    websiteCheck: normalizeWebsiteCheck(raw.websiteCheck)
  };
}

function normalizeEvents(value) {
  if (!Array.isArray(value)) return [];
  return value.map((event) => ({
    title: String(event?.title ?? "").trim(),
    date: String(event?.date ?? "").trim(),
    start: String(event?.start ?? "").trim(),
    end: String(event?.end ?? "").trim(),
    locationName: String(event?.locationName ?? "").trim(),
    address: String(event?.address ?? "").trim(),
    notes: String(event?.notes ?? "").trim(),
    coordinates: normalizeCoordinates(event?.coordinates)
  }));
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
      url: normalizeHttpUrl(link.url, { path: "Initiative link" })
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

function validateInitiatives(initiatives) {
  const ids = new Set();

  for (const item of initiatives) {
    if (!item.id || !item.name || !item.region || !item.country) {
      throw new Error(`Invalid initiative: ${JSON.stringify(item)}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate initiative id: ${item.id}`);
    ids.add(item.id);
    for (const link of [item.url, ...item.sources.map((source) => source.url), ...item.transitLinks.map((link) => link.url)].filter(Boolean)) {
      normalizeHttpUrl(link, { path: `Initiative ${item.id} link` });
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
    for (const event of item.events) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
          ![event.start, event.end].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
        throw new Error(`Invalid event in ${item.id}`);
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
    for (const event of initiative.events) {
      if (event.coordinates) continue;
      const matchedLocation = initiative.locations.find((location) =>
        event.locationName && normalizeComparable(location.name) === normalizeComparable(event.locationName)
      );
      if (!event.address && matchedLocation?.coordinates) {
        event.coordinates = matchedLocation.coordinates;
        continue;
      }
      const query = event.address || matchedLocation?.address;
      if (!query) continue;
      const key = `${GEOCODE_CACHE_VERSION}|${initiative.country}|${initiative.region}|${query}`;
      if (!(key in cache)) {
        cache[key] = await geocodeInitiative(initiative, query);
        await delay(1100);
      }
      event.coordinates = cache[key];
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
  return fetchPublicWebsite(url, {
    method,
    timeoutMs: WEBSITE_CHECK_TIMEOUT_MS
  });
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
  const timestamp = report.startedAt.toISOString().replace(/[:.]/g, "-");
  const logPath = new URL(`${timestamp}.md`, LOGS_DIR);
  const lines = reportLines(report);
  await writeFile(logPath, `${lines.join("\n")}\n`);
  console.log(`Wrote update log to logs/${timestamp}.md`);
}

function reportLines(report) {
  const finishedAt = new Date();
  const lines = [
    `# Update log ${report.startedAt.toISOString()}`,
    "",
    `- Result: ${report.error ? "failed" : "success"}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Duration: ${finishedAt.getTime() - report.startedAt.getTime()} ms`
  ];

  if (report.summary) {
    lines.push(
      `- Initiatives: ${report.summary.total} total, ${report.summary.scraped} scraped, ${report.summary.managed} managed`
    );
  }

  if (report.error) {
    lines.push("", "## Fatal error", "", `- ${report.error}`);
  }

  appendWebsiteFailures(lines, report.websiteFailures);
  appendWebsiteTransitions(lines, report.websiteTransitions);
  appendGroupReport(lines, report.groups);
  appendDatasetChanges(lines, report.changes);
  appendListSection(lines, "Warnings", report.warnings);
  return lines;
}

async function writeWorkflowSummary(report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${reportLines(report).join("\n")}\n`);
}

function appendGroupReport(lines, groups) {
  lines.push("", "## Group files", "");
  if (!groups) {
    lines.push("- Group synchronization did not run.");
    return;
  }
  lines.push(
    `- New: ${groups.added.length}`,
    `- Changed: ${groups.changed.length}`,
    `- Hidden: ${groups.hidden.length}`,
    `- Invalid: ${groups.invalid.length}`,
    `- Missing: ${groups.missing.length}`,
    `- Stale: ${groups.stale.length}`,
    `- Unchanged: ${groups.unchanged.length}`
  );
  appendGroupChanges(lines, "New group files", groups.added);
  appendGroupChanges(lines, "Changed group files", groups.changed);
  appendGroupChanges(lines, "Hidden group files", groups.hidden);
  appendListSection(lines, "Invalid group files", groups.invalid.map((item) =>
    `\`${item.id}\`: ${item.error}${item.fallback ? " (using cached data)" : " (ignored)"}`
  ));
  appendListSection(lines, "Missing group files", groups.missing.map((id) =>
    `\`${id}\` (using cached data)`
  ));
  appendListSection(lines, "Stale group files", groups.stale.map((id) =>
    `\`${id}\` has not changed for more than 180 days`
  ));
}

function appendGroupChanges(lines, title, entries) {
  lines.push("", `### ${title} (${entries.length})`, "");
  if (!entries.length) {
    lines.push("- None");
    return;
  }
  for (const entry of entries) {
    lines.push(`- \`${entry.id}\``);
    for (const change of entry.changes) {
      lines.push(`  - \`${change.field}\`: ${formatLogValue(change.before)} -> ${formatLogValue(change.after)}`);
    }
  }
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
  <link rel="stylesheet" href="assets/site.css">
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
  <script src="assets/site.js"></script>
</body>
</html>
`;
}

function toPageInitiatives(initiatives) {
  return initiatives.map(({ sources, websiteCheck, ...item }) => item);
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
  groups: emptyGroupReport(),
  warnings: [],
  error: ""
};

await loadEnvFile(new URL("../.env", import.meta.url));

try {
  await main(report);
} catch (error) {
  report.error = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await writeRunLog(report);
    await writeWorkflowSummary(report);
  } catch (error) {
    console.error("Failed to write update log:", error);
    process.exitCode = 1;
  }
}
