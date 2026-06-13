import { readFile, writeFile } from "node:fs/promises";
import { normalizeHttpUrl } from "./url-security.mjs";

export const GROUP_CACHE_VERSION = 1;
const GROUP_PARSER_VERSION = 3;
const MAX_FILE_BYTES = 128 * 1024;
const MAX = {
  name: 120,
  city: 100,
  region: 100,
  country: 80,
  website: 2048,
  locationName: 120,
  address: 240,
  notes: 1000,
  body: 5000,
  eventTitle: 160
};
const ID_PATTERN = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECTION_NAMES = new Set(["Initiative", "Tauschorte", "Einzeltermine", "Weitere Hinweise"]);
const INITIATIVE_FIELDS = new Set(["Status", "Name", "Ort", "Bundesland / Region", "Land", "Webseite"]);
const LOCATION_HEADERS = [
  "Name", "Adresse", "Wochentage", "Wochen im Monat", "Von", "Bis", "Ortshinweise", "Terminhinweise"
];
const EVENT_HEADERS = ["Titel", "Datum", "Von", "Bis", "Ort", "Adresse", "Hinweise"];
const WEEKDAYS = new Map([
  ["montag", 1],
  ["dienstag", 2],
  ["mittwoch", 3],
  ["donnerstag", 4],
  ["freitag", 5],
  ["samstag", 6],
  ["sonntag", 7]
]);

export async function readGroupCache(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.version !== GROUP_CACHE_VERSION || typeof parsed.entries !== "object" || !parsed.entries) {
      throw new Error("Unsupported group cache format");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: GROUP_CACHE_VERSION, entries: {} };
    throw error;
  }
}

export async function writeGroupCache(path, cache) {
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`);
}

export async function syncGroupData({
  cache,
  credentials = credentialsFromEnv(),
  fetchImpl = fetch,
  now = new Date(),
  allowFallback = false
}) {
  const result = {
    cache,
    entries: cache.entries,
    report: emptyGroupReport(),
    connected: false
  };

  if (!credentials) {
    if (!allowFallback) {
      throw new Error("Nextcloud configuration missing. Set NEXTCLOUD_SHARE_URL in .env or the environment.");
    }
    result.report.warnings.push("Nextcloud credentials unavailable; using the last valid group cache.");
    markStaleEntries(result.report, cache.entries, now);
    return result;
  }

  let remoteFiles;
  try {
    remoteFiles = await listMarkdownFiles(credentials, fetchImpl);
    result.connected = true;
  } catch {
    if (!allowFallback) {
      throw new Error("Nextcloud group folder is unavailable. Check NEXTCLOUD_SHARE_URL and share permissions.");
    }
    result.report.warnings.push("Nextcloud unavailable; using the last valid group cache.");
    markStaleEntries(result.report, cache.entries, now);
    return result;
  }

  const remoteIds = new Set(remoteFiles.map((file) => file.id));
  for (const id of Object.keys(cache.entries)) {
    if (!remoteIds.has(id)) result.report.missing.push(id);
  }

  for (const file of remoteFiles) {
    const previous = cache.entries[file.id];
    if (previous?.etag === file.etag && previous.parserVersion === GROUP_PARSER_VERSION) {
      result.report.unchanged.push(file.id);
      continue;
    }

    try {
      const markdown = await downloadMarkdown(credentials, file, fetchImpl);
      const data = parseGroupMarkdown(file.id, markdown, now);
      const next = cacheEntry(file, data, now);
      cache.entries[file.id] = next;
      const changes = diffGroupData(previous?.data, next.data);
      if (!previous) result.report.added.push({ id: file.id, changes });
      else if (next.data.status === "hidden" && previous.data.status !== "hidden") {
        result.report.hidden.push({ id: file.id, changes });
      } else {
        result.report.changed.push({ id: file.id, changes });
      }
    } catch (error) {
      result.report.invalid.push({
        id: file.id,
        error: safeValidationMessage(error),
        fallback: Boolean(previous)
      });
    }
  }

  markStaleEntries(result.report, cache.entries, now);
  return result;
}

export function mergeGroupInitiatives(scraped, entries, now = new Date()) {
  const visible = new Map(scraped.map((item) => [item.id, item]));
  const today = berlinIsoDate(now);

  for (const [id, entry] of Object.entries(entries)) {
    const data = entry.data;
    for (const [candidateId, candidate] of visible) {
      if (candidateId === id || samePlace(candidate, data)) visible.delete(candidateId);
    }
    if (data.status === "hidden") continue;
    visible.set(id, {
      id,
      name: data.name,
      city: data.city,
      region: data.region,
      country: data.country,
      url: data.website,
      updatedAt: entry.modifiedAt,
      locations: data.locations,
      events: data.events.filter((event) => event.date >= today),
      notes: data.notes,
      sources: []
    });
  }

  return [...visible.values()];
}

export function parseGroupMarkdown(id, markdown, now = new Date()) {
  assert(ID_PATTERN.test(id), "id: invalid filename");
  assert(Buffer.byteLength(markdown, "utf8") <= MAX_FILE_BYTES, "file: too large");
  const sections = parseSections(markdown);
  const initiative = parseInitiativeTable(sections.get("Initiative"));
  const status = normalizeStatus(initiative.Status);
  if (status === "hidden") return { status: "hidden" };

  const locations = parseLocationsTable(sections.get("Tauschorte"));
  const events = parseEventsTable(sections.get("Einzeltermine"))
    .filter((event) => event.date >= berlinIsoDate(now))
    .sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`));

  return {
    status: "active",
    name: requiredText(initiative.Name, "Initiative.Name", MAX.name),
    city: requiredText(initiative.Ort, "Initiative.Ort", MAX.city),
    region: requiredText(initiative["Bundesland / Region"], "Initiative.Bundesland / Region", MAX.region),
    country: requiredText(initiative.Land, "Initiative.Land", MAX.country),
    website: optionalHttpUrl(initiative.Webseite, "Initiative.Webseite"),
    locations,
    events,
    notes: sanitizePlainText(sections.get("Weitere Hinweise") ?? "", MAX.body)
  };
}

export function sanitizePlainText(value, maxLength) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function emptyGroupReport() {
  return {
    added: [],
    changed: [],
    hidden: [],
    invalid: [],
    missing: [],
    stale: [],
    unchanged: [],
    warnings: []
  };
}

function parseSections(markdown) {
  const normalized = String(markdown).replace(/\r\n?/g, "\n");
  assert(/^# Gruppendaten\s*$/m.test(normalized), "document: heading '# Gruppendaten' required");
  const headings = [...normalized.matchAll(/^## ([^\n]+)\s*$/gm)];
  assert(headings.length, "document: sections required");
  const sections = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const name = headings[index][1].trim();
    assert(SECTION_NAMES.has(name), `section '${name}': unknown`);
    assert(!sections.has(name), `section '${name}': duplicate`);
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? normalized.length;
    sections.set(name, normalized.slice(start, end).trim());
  }
  assert(sections.has("Initiative"), "section 'Initiative': required");
  return sections;
}

function parseInitiativeTable(section) {
  const rows = parseTable(section, ["Feld", "Wert"], "Initiative");
  const values = {};
  for (const [field, value] of rows) {
    assert(INITIATIVE_FIELDS.has(field), `Initiative.${field}: unknown field`);
    assert(!(field in values), `Initiative.${field}: duplicate field`);
    values[field] = value;
  }
  assert(values.Status, "Initiative.Status: required");
  return values;
}

function parseLocationsTable(section = "") {
  if (!section.trim()) return [];
  const rows = parseTable(section, LOCATION_HEADERS, "Tauschorte");
  const locations = new Map();

  rows.forEach((row, index) => {
    const path = `Tauschorte[${index + 1}]`;
    const [rawName, rawAddress, rawWeekdays, rawWeeks, rawStart, rawEnd, rawLocationNotes, rawSlotNotes] = row;
    const name = optionalText(rawName, `${path}.Name`, MAX.locationName);
    const address = optionalText(rawAddress, `${path}.Adresse`, MAX.address);
    const notes = optionalText(rawLocationNotes, `${path}.Ortshinweise`, MAX.notes);
    assert(name || address, `${path}: Name or Adresse required`);
    const scheduleValues = [rawWeekdays, rawWeeks, rawStart, rawEnd, rawSlotNotes].some((value) => value.trim());
    let slot = null;
    if (scheduleValues) {
      slot = {
        weekdays: parseWeekdays(rawWeekdays, `${path}.Wochentage`),
        weeksOfMonth: parseWeeksOfMonth(rawWeeks, `${path}.Wochen im Monat`),
        start: requiredTime(rawStart, `${path}.Von`),
        end: requiredTime(rawEnd, `${path}.Bis`),
        notes: optionalText(rawSlotNotes, `${path}.Terminhinweise`, MAX.notes)
      };
      assert(slot.start < slot.end, `${path}: Bis must be after Von`);
    }
    const key = JSON.stringify([name, address]);
    if (!locations.has(key)) locations.set(key, { name, address, notes, openingSlots: [] });
    const location = locations.get(key);
    if (notes && location.notes && notes !== location.notes) {
      throw new Error(`${path}.Ortshinweise: use the same text for all rows of one location`);
    }
    if (notes) location.notes = notes;
    if (slot) location.openingSlots.push(slot);
  });

  return [...locations.values()];
}

function parseEventsTable(section = "") {
  if (!section.trim()) return [];
  return parseTable(section, EVENT_HEADERS, "Einzeltermine").map((row, index) => {
    const path = `Einzeltermine[${index + 1}]`;
    const [title, rawDate, start, end, locationName, address, notes] = row;
    const date = parseGermanDate(rawDate, `${path}.Datum`);
    const normalizedStart = requiredTime(start, `${path}.Von`);
    const normalizedEnd = requiredTime(end, `${path}.Bis`);
    assert(normalizedStart < normalizedEnd, `${path}: Bis must be after Von`);
    return {
      title: requiredText(title, `${path}.Titel`, MAX.eventTitle),
      date,
      start: normalizedStart,
      end: normalizedEnd,
      locationName: optionalText(locationName, `${path}.Ort`, MAX.locationName),
      address: optionalText(address, `${path}.Adresse`, MAX.address),
      notes: optionalText(notes, `${path}.Hinweise`, MAX.notes)
    };
  });
}

function parseTable(section, expectedHeaders, path) {
  const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
  assert(lines.length >= 2, `${path}: table required`);
  const rawHeaders = parseTableRow(lines[0], `${path}: header`);
  const usedColumns = rawHeaders
    .map((header, index) => header ? index : null)
    .filter((index) => index !== null);
  const headers = usedColumns.map((index) => rawHeaders[index]);
  assert(JSON.stringify(headers) === JSON.stringify(expectedHeaders), `${path}: invalid columns`);
  const separator = parseTableRow(lines[1], `${path}: separator`);
  assert(separator.length === rawHeaders.length && separator.every((value, index) =>
    rawHeaders[index] ? /^:?-{3,}:?$/.test(value) : !value || /^:?-+:?$/.test(value)
  ), `${path}: invalid table separator`);
  return lines.slice(2).flatMap((line, index) => {
    const rawRow = parseTableRow(line, `${path}[${index + 1}]`);
    assert(rawRow.length === rawHeaders.length, `${path}[${index + 1}]: expected ${rawHeaders.length} columns`);
    const unnamedValues = rawRow.filter((_, columnIndex) => !rawHeaders[columnIndex]);
    assert(unnamedValues.every((value) => !value), `${path}[${index + 1}]: unnamed columns must be empty`);
    const row = usedColumns.map((columnIndex) => rawRow[columnIndex]);
    return row.every((value) => !value) ? [] : [row];
  });
}

function parseTableRow(line, path) {
  assert(line.startsWith("|") && line.endsWith("|"), `${path}: row must start and end with |`);
  return line.slice(1, -1).split("|").map((value) => value.trim());
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLocaleLowerCase("de-DE");
  if (status === "aktiv") return "active";
  if (status === "ausgeblendet") return "hidden";
  throw new Error("Initiative.Status: use 'aktiv' or 'ausgeblendet'");
}

function parseWeekdays(value, path) {
  const names = String(value).split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  assert(names.length, `${path}: required`);
  const days = names.map((name) => WEEKDAYS.get(name.toLocaleLowerCase("de-DE")));
  assert(days.every(Boolean), `${path}: use full German weekday names`);
  return [...new Set(days)].sort((left, right) => left - right);
}

function parseWeeksOfMonth(value, path) {
  const normalized = String(value).trim().toLocaleLowerCase("de-DE");
  if (!normalized || normalized === "jede" || normalized === "jede woche") return [];
  const weeks = normalized.split(/[,;]/).map((week) => Number(week.trim()));
  assert(weeks.length && weeks.every((week) => Number.isInteger(week) && week >= 1 && week <= 5), `${path}: use 1 to 5 or 'jede'`);
  return [...new Set(weeks)].sort((left, right) => left - right);
}

function parseGermanDate(value, path) {
  const text = String(value).trim();
  let date = text;
  const german = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (german) date = `${german[3]}-${german[2]}-${german[1]}`;
  assert(DATE_PATTERN.test(date) && isoDate(new Date(`${date}T12:00:00Z`)) === date, `${path}: use TT.MM.JJJJ`);
  return date;
}

async function listMarkdownFiles(credentials, fetchImpl) {
  const response = await fetchImpl(webdavFolderUrl(credentials), {
    method: "PROPFIND",
    headers: {
      authorization: basicAuth(credentials),
      depth: "1",
      "content-type": "application/xml; charset=utf-8"
    },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`
  });
  if (!response.ok && response.status !== 207) throw new Error("PROPFIND failed");
  const xml = await response.text();
  return parseWebdavListing(xml, credentials);
}

function parseWebdavListing(xml, credentials) {
  const files = [];
  for (const block of xml.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) ?? []) {
    if (/<(?:\w+:)?collection\s*\/?>/i.test(block)) continue;
    const href = xmlValue(block, "href");
    const filename = decodeURIComponent(new URL(href, credentials.url).pathname.split("/").pop() ?? "");
    if (!filename.endsWith(".md")) continue;
    const id = filename.slice(0, -3);
    if (!ID_PATTERN.test(id)) continue;
    files.push({
      id,
      filename,
      href: new URL(href, credentials.url).toString(),
      etag: xmlValue(block, "getetag"),
      modifiedAt: normalizeModifiedAt(xmlValue(block, "getlastmodified"))
    });
  }
  return files.sort((left, right) => left.id.localeCompare(right.id));
}

async function downloadMarkdown(credentials, file, fetchImpl) {
  const response = await fetchImpl(file.href, {
    headers: { authorization: basicAuth(credentials) }
  });
  if (!response.ok) throw new Error("download: failed");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FILE_BYTES) throw new Error("file: too large");
  return response.text();
}

function cacheEntry(file, data, now) {
  return {
    parserVersion: GROUP_PARSER_VERSION,
    etag: file.etag,
    modifiedAt: file.modifiedAt,
    checkedAt: now.toISOString(),
    data
  };
}

export function credentialsFromEnv(env = process.env) {
  const {
    NEXTCLOUD_SHARE_URL,
    NEXTCLOUD_SHARE_PASSWORD,
    NEXTCLOUD_URL,
    NEXTCLOUD_USERNAME,
    NEXTCLOUD_APP_PASSWORD,
    NEXTCLOUD_FOLDER
  } = env;
  if (NEXTCLOUD_SHARE_URL) return publicShareCredentials(NEXTCLOUD_SHARE_URL, NEXTCLOUD_SHARE_PASSWORD);
  if (![NEXTCLOUD_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_APP_PASSWORD, NEXTCLOUD_FOLDER].every(Boolean)) return null;
  return {
    mode: "account",
    url: NEXTCLOUD_URL,
    username: NEXTCLOUD_USERNAME,
    password: NEXTCLOUD_APP_PASSWORD,
    folder: NEXTCLOUD_FOLDER
  };
}

function webdavFolderUrl(credentials) {
  if (credentials.mode === "public-share") return credentials.davUrl;
  const base = new URL(credentials.url);
  const root = base.pathname.replace(/\/+$/, "");
  const encodedFolder = credentials.folder.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  base.pathname = `${root}/remote.php/dav/files/${encodeURIComponent(credentials.username)}/${encodedFolder}/`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function basicAuth(credentials) {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

function publicShareCredentials(shareUrl, password = "") {
  let parsed;
  try {
    parsed = new URL(shareUrl);
  } catch {
    throw new Error("NEXTCLOUD_SHARE_URL is invalid");
  }
  const match = parsed.pathname.match(/\/s\/([A-Za-z0-9]+)\/?$/);
  if (!match) throw new Error("NEXTCLOUD_SHARE_URL must be a Nextcloud /s/<token> link");
  const token = match[1];
  const davUrl = new URL(parsed.origin);
  davUrl.pathname = `/public.php/dav/files/${encodeURIComponent(token)}/`;
  return {
    mode: "public-share",
    url: parsed.origin,
    davUrl: davUrl.toString(),
    username: token,
    password
  };
}

function xmlValue(block, name) {
  const match = block.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"));
  return decodeXml(match?.[1]?.trim() ?? "");
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function normalizeModifiedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function diffGroupData(before, after) {
  if (!before) return Object.keys(after).map((field) => ({ field, before: null, after: after[field] }));
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

function markStaleEntries(report, entries, now) {
  const threshold = now.getTime() - 180 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(entries)) {
    const modified = new Date(entry.modifiedAt).getTime();
    if (Number.isFinite(modified) && modified < threshold) report.stale.push(id);
  }
}

function samePlace(left, right) {
  if (right.status === "hidden") return false;
  return comparable(left.city) === comparable(right.city) &&
    comparable(left.region) === comparable(right.region) &&
    comparable(left.country) === comparable(right.country);
}

function comparable(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function requiredTime(value, path) {
  const text = scalarString(value);
  assert(TIME_PATTERN.test(text), `${path}: invalid time`);
  return text;
}

function requiredText(value, path, maxLength) {
  const text = optionalText(value, path, maxLength);
  assert(text, `${path}: required`);
  return text;
}

function optionalText(value, path, maxLength) {
  if (value === undefined || value === null) return "";
  assert(typeof value === "string", `${path}: must be text`);
  assert(value.length <= maxLength, `${path}: too long`);
  const text = sanitizePlainText(value, maxLength);
  return text;
}

function optionalHttpUrl(value, path) {
  if (value === undefined || value === null || value === "") return "";
  assert(typeof value === "string" && value.length <= MAX.website, `${path}: invalid URL`);
  return normalizeHttpUrl(value, { path });
}

function scalarString(value) {
  if (value instanceof Date) return isoDate(value);
  return String(value ?? "");
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function berlinIsoDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function safeValidationMessage(error) {
  const message = String(error?.message || "invalid group file");
  return message.replace(/[\r\n].*/s, "").slice(0, 240);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
