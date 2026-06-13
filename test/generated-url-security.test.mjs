import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeHttpUrl } from "../scripts/url-security.mjs";

test("the updater validates every externally supplied browser URL", async () => {
  const source = await readFile(new URL("../scripts/update-site.mjs", import.meta.url), "utf8");
  assert.match(source, /normalizeHttpUrl\(decodeHtml\(link\[1\]\), \{ baseUrl: SOURCE_URL/);
  assert.match(source, /raw\.url \? normalizeHttpUrl\(raw\.url/);
  assert.match(source, /url: normalizeHttpUrl\(link\.url/);
  assert.match(source, /return fetchPublicWebsite\(url, \{/);
});

test("the committed page contains only credential-free HTTP(S) initiative links", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="application\/json" id="initiative-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "initiative-data JSON is missing");
  const initiatives = JSON.parse(match[1]);

  for (const item of initiatives) {
    for (const value of [
      item.url,
      ...(item.sources || []).map((link) => link.url),
      ...(item.transitLinks || []).map((link) => link.url)
    ].filter(Boolean)) {
      assert.equal(normalizeHttpUrl(value), value, `${item.id}: ${value}`);
    }
  }
});
