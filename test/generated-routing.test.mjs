import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import test from "node:test";

const files = [
  new URL("../src/browser/site.js", import.meta.url),
  new URL("../assets/site.js", import.meta.url)
];

for (const file of files) {
  test(`routing generations abort stale work in ${file.pathname.split("/").at(-1)}`, async () => {
    const source = await readFile(file, "utf8");
    const reset = extractFunction(source, "resetRoutingGeneration");
    const isCurrent = extractFunction(source, "isCurrentRoutingGeneration");
    const assertCurrent = extractFunction(source, "assertCurrentRoutingGeneration");
    const context = createContext({ AbortController, Error, Map });

    new Script(`
      let transitPreference = "enabled";
      let routingGeneration = 0;
      let routingController = new AbortController();
      const cityStationCache = new Map([["pending", Promise.resolve()]]);
      ${reset}
      ${isCurrent}
      ${assertCurrent}
      globalThis.routingTest = {
        resetRoutingGeneration,
        isCurrentRoutingGeneration,
        assertCurrentRoutingGeneration,
        get generation() { return routingGeneration; },
        get signal() { return routingController.signal; },
        get cacheSize() { return cityStationCache.size; },
        setPreference(value) { transitPreference = value; }
      };
    `).runInContext(context);

    const routing = context.routingTest;
    const staleSignal = routing.signal;
    routing.resetRoutingGeneration();

    assert.equal(staleSignal.aborted, true);
    assert.equal(routing.generation, 1);
    assert.equal(routing.cacheSize, 0);
    assert.equal(routing.isCurrentRoutingGeneration(0, staleSignal), false);
    assert.equal(routing.isCurrentRoutingGeneration(1, routing.signal), true);

    routing.setPreference("disabled");
    assert.equal(routing.isCurrentRoutingGeneration(1, routing.signal), false);
    assert.throws(
      () => routing.assertCurrentRoutingGeneration(1, routing.signal),
      (error) => error.name === "AbortError"
    );
  });

  test(`routing integration guards state and cache writes in ${file.pathname.split("/").at(-1)}`, async () => {
    const source = await readFile(file, "utf8");
    const routeVisible = extractFunction(source, "routeVisibleInitiatives");
    const fetchTravelTime = extractFunction(source, "fetchCityTravelTime");
    const fetchStation = extractFunction(source, "fetchCityStation");

    assert.match(routeVisible, /const signal = routingController\.signal/);
    assert.match(routeVisible, /await fetchCityTravelTime\(item, generation, signal\)/);
    assert.match(routeVisible, /if \(!isCurrentRoutingGeneration\(generation, signal\)\) return;/);
    assert.match(fetchTravelTime, /fetch\(TRANSITOUS_URL \+ "\?" \+ params, \{ signal \}\)/);
    assert.match(fetchStation, /fetch\("https:\/\/api\.transitous\.org\/api\/v1\/geocode\?" \+ params, \{ signal \}\)/);
    const finalGuard = fetchTravelTime.lastIndexOf("assertCurrentRoutingGeneration(generation, signal)");
    const cacheWrite = fetchTravelTime.indexOf("writeRouteCache(cacheKey, result, true)");
    assert.ok(
      finalGuard > fetchTravelTime.indexOf("const result =") &&
        finalGuard < cacheWrite
    );
  });
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}
