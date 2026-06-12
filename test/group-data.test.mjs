import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  credentialsFromEnv,
  mergeGroupInitiatives,
  parseGroupMarkdown,
  syncGroupData
} from "../scripts/group-data.mjs";

const NOW = new Date("2026-06-12T12:00:00Z");
const ACTIVE = `# Gruppendaten

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
| Stadtteilladen | Kieler Str. 12, 24143 Kiel | Mittwoch | jede | 17:00 | 19:00 | <b>Eingang</b> im Hinterhof | |

## Einzeltermine

| Titel | Datum | Von | Bis | Ort | Adresse | Hinweise |
| --- | --- | --- | --- | --- | --- | --- |
| Vergangen | 11.06.2026 | 15:00 | 18:00 | | | |
| Zukünftig | 18.07.2026 | 15:00 | 18:00 | Stadtteilladen | | |

## Weitere Hinweise

Hallo <script>alert(1)</script> **Welt**.
`;

test("derives public WebDAV credentials from a browser share link", () => {
  const credentials = credentialsFromEnv({
    NEXTCLOUD_SHARE_URL: "https://cloud.example/s/PublicToken123",
    NEXTCLOUD_SHARE_PASSWORD: "optional-password"
  });
  assert.equal(credentials.mode, "public-share");
  assert.equal(credentials.davUrl, "https://cloud.example/public.php/dav/files/PublicToken123/");
  assert.equal(credentials.username, "PublicToken123");
  assert.equal(credentials.password, "optional-password");
});

test("upload-ready group tables are valid", async () => {
  for (const id of ["kiel", "eutin", "lübeck", "bargteheide", "hamburg"]) {
    const markdown = await readFile(new URL(`../examples/group-data/${id}.md`, import.meta.url), "utf8");
    const parsed = parseGroupMarkdown(id, markdown, NOW);
    assert.equal(parsed.status, "active", id);
    assert.ok(parsed.name, id);
  }
});

test("normalizes active group data and drops past events", () => {
  const data = parseGroupMarkdown("kiel", ACTIVE, NOW);
  assert.equal(data.website, "https://example.org/");
  assert.equal(data.locations[0].notes, "Eingang im Hinterhof");
  assert.deepEqual(data.events.map((event) => event.title), ["Zukünftig"]);
  assert.equal(data.notes, "Hallo alert(1) **Welt**.");
});

test("ignores completely empty table rows", () => {
  const withEmptyRow = ACTIVE.replace(
    "| Stadtteilladen | Kieler Str. 12, 24143 Kiel |",
    "| | | | | | | | |\n| Stadtteilladen | Kieler Str. 12, 24143 Kiel |"
  );
  assert.equal(parseGroupMarkdown("kiel", withEmptyRow, NOW).locations.length, 1);
});

test("accepts hidden files without content fields", () => {
  assert.deepEqual(parseGroupMarkdown("kiel", `# Gruppendaten

## Initiative

| Feld | Wert |
| --- | --- |
| Status | ausgeblendet |
`, NOW), { status: "hidden" });
  assert.equal(parseGroupMarkdown("lübeck", ACTIVE, NOW).status, "active");
});

test("rejects unknown fields, unsafe URLs, weekday numbers and invalid events", () => {
  assert.throws(() => parseGroupMarkdown("kiel", ACTIVE.replace("| Name | Anti-SocialCard Kiel |", "| Unbekannt | Wert |"), NOW), /unknown field/);
  assert.throws(() => parseGroupMarkdown("kiel", ACTIVE.replace("https://example.org/", "javascript:alert(1)"), NOW), /http\/https/);
  assert.throws(() => parseGroupMarkdown("kiel", ACTIVE.replace("Mittwoch | jede", "3 | jede"), NOW), /weekday names/);
  assert.throws(() => parseGroupMarkdown("kiel", ACTIVE.replace("15:00 | 18:00 | Stadtteilladen", "15:00 | 14:00 | Stadtteilladen"), NOW), /after Von/);
});

test("active groups replace the same place and hidden groups suppress matching ids", () => {
  const scraped = [{
    id: "seebruecke-kiel",
    name: "Kiel",
    city: "Kiel",
    region: "Schleswig-Holstein",
    country: "Deutschland"
  }, {
    id: "hidden-id",
    name: "Hidden",
    city: "Bremen",
    region: "Bremen",
    country: "Deutschland"
  }];
  const entries = {
    kiel: { modifiedAt: "2026-06-12T10:00:00Z", data: parseGroupMarkdown("kiel", ACTIVE, NOW) },
    "hidden-id": { modifiedAt: "2026-06-12T10:00:00Z", data: { status: "hidden" } }
  };
  const merged = mergeGroupInitiatives(scraped, entries, NOW);
  assert.deepEqual(merged.map((item) => item.id), ["kiel"]);
  assert.equal(merged[0].updatedAt, "2026-06-12T10:00:00Z");
});

test("unchanged ETags avoid downloads", async () => {
  const cache = {
    version: 1,
    entries: {
      kiel: {
        parserVersion: 2,
        etag: "\"same\"",
        modifiedAt: "2026-06-12T10:00:00Z",
        checkedAt: "2026-06-12T10:00:00Z",
        data: parseGroupMarkdown("kiel", ACTIVE, NOW)
      }
    }
  };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    return new Response(`<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:"><d:response>
        <d:href>/remote.php/dav/files/test/groups/kiel.md</d:href>
        <d:propstat><d:prop><d:getetag>&quot;same&quot;</d:getetag>
        <d:getlastmodified>Fri, 12 Jun 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/></d:prop></d:propstat>
      </d:response></d:multistatus>`, { status: 207 });
  };
  const result = await syncGroupData({
    cache,
    credentials: { url: "https://cloud.example/", username: "test", password: "secret", folder: "groups" },
    fetchImpl,
    now: NOW
  });
  assert.deepEqual(requests.map((request) => request.method), ["PROPFIND"]);
  assert.deepEqual(result.report.unchanged, ["kiel"]);
});

test("invalid changed files retain the last valid cache entry", async () => {
  const valid = parseGroupMarkdown("kiel", ACTIVE, NOW);
  const cache = {
    version: 1,
    entries: {
      kiel: {
        parserVersion: 2,
        etag: "\"old\"",
        modifiedAt: "2026-06-12T10:00:00Z",
        checkedAt: "2026-06-12T10:00:00Z",
        data: valid
      }
    }
  };
  let request = 0;
  const fetchImpl = async () => {
    request += 1;
    if (request === 1) {
      return new Response(`<d:multistatus xmlns:d="DAV:"><d:response>
        <d:href>/remote.php/dav/files/test/groups/kiel.md</d:href>
        <d:propstat><d:prop><d:getetag>&quot;new&quot;</d:getetag>
        <d:getlastmodified>Fri, 12 Jun 2026 11:00:00 GMT</d:getlastmodified>
        <d:resourcetype/></d:prop></d:propstat>
      </d:response></d:multistatus>`, { status: 207 });
    }
    return new Response("# Gruppendaten\n\n## Initiative\n\nnot a table\n", { status: 200 });
  };
  const result = await syncGroupData({
    cache,
    credentials: { url: "https://cloud.example/", username: "test", password: "secret", folder: "groups" },
    fetchImpl,
    now: NOW
  });
  assert.equal(result.cache.entries.kiel.etag, "\"old\"");
  assert.equal(result.report.invalid[0].fallback, true);
});

test("changed ETags download, normalize and report field diffs", async () => {
  const oldData = parseGroupMarkdown("kiel", ACTIVE, NOW);
  const cache = {
    version: 1,
    entries: {
      kiel: {
        parserVersion: 2,
        etag: "\"old\"",
        modifiedAt: "2026-06-12T10:00:00Z",
        checkedAt: "2026-06-12T10:00:00Z",
        data: oldData
      }
    }
  };
  let request = 0;
  const fetchImpl = async () => {
    request += 1;
    if (request === 1) {
      return new Response(`<d:multistatus xmlns:d="DAV:"><d:response>
        <d:href>/remote.php/dav/files/test/groups/kiel.md</d:href>
        <d:propstat><d:prop><d:getetag>&quot;new&quot;</d:getetag>
        <d:getlastmodified>Fri, 12 Jun 2026 11:00:00 GMT</d:getlastmodified>
        <d:resourcetype/></d:prop></d:propstat>
      </d:response></d:multistatus>`, { status: 207 });
    }
    return new Response(ACTIVE.replace("Anti-SocialCard Kiel", "Neue Initiative Kiel"), { status: 200 });
  };
  const result = await syncGroupData({
    cache,
    credentials: { url: "https://cloud.example/", username: "test", password: "secret", folder: "groups" },
    fetchImpl,
    now: NOW
  });
  assert.equal(result.cache.entries.kiel.etag, "\"new\"");
  assert.equal(result.cache.entries.kiel.data.name, "Neue Initiative Kiel");
  assert.deepEqual(result.report.changed[0].changes.map((change) => change.field), ["name"]);
});

test("missing credentials fail unless cache fallback is explicitly enabled", async () => {
  const cache = {
    version: 1,
    entries: {
      kiel: {
        parserVersion: 2,
        etag: "\"old\"",
        modifiedAt: "2026-06-12T10:00:00Z",
        checkedAt: "2026-06-12T10:00:00Z",
        data: parseGroupMarkdown("kiel", ACTIVE, NOW)
      }
    }
  };
  await assert.rejects(
    syncGroupData({ cache, credentials: null, now: NOW }),
    /Nextcloud configuration missing/
  );
  const offline = await syncGroupData({ cache, credentials: null, now: NOW, allowFallback: true });
  assert.ok(offline.entries.kiel);
});

test("unreachable Nextcloud fails unless cache fallback is explicitly enabled", async () => {
  const cache = { version: 1, entries: {} };
  const credentials = { url: "https://cloud.example/", username: "test", password: "secret", folder: "groups" };
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  await assert.rejects(
    syncGroupData({ cache, credentials, fetchImpl, now: NOW }),
    /Nextcloud group folder is unavailable/
  );
  const offline = await syncGroupData({ cache, credentials, fetchImpl, now: NOW, allowFallback: true });
  assert.equal(offline.connected, false);
  assert.equal(offline.report.warnings.length, 1);
});

test("missing remote files preserve cached data and are reported", async () => {
  const cache = {
    version: 1,
    entries: {
      kiel: {
        etag: "\"old\"",
        modifiedAt: "2026-06-12T10:00:00Z",
        checkedAt: "2026-06-12T10:00:00Z",
        data: parseGroupMarkdown("kiel", ACTIVE, NOW)
      }
    }
  };
  const missing = await syncGroupData({
    cache,
    credentials: { url: "https://cloud.example/", username: "test", password: "secret", folder: "groups" },
    fetchImpl: async () => new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }),
    now: NOW
  });
  assert.deepEqual(missing.report.missing, ["kiel"]);
  assert.ok(missing.entries.kiel);
});
