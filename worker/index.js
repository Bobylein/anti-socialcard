import { DurableObject } from "cloudflare:workers";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
const APPLICATION_URL = "https://tauschaktionen-finder.peter161.workers.dev/";
const CACHE_SECONDS = 30 * 24 * 60 * 60;
const NOMINATIM_INTERVAL_MS = 1000;
const SEARCH_PARAMETERS = new Set([
  "q",
  "countrycodes",
  "addressdetails",
  "namedetails"
]);
const REVERSE_PARAMETERS = new Set([
  "lat",
  "lon",
  "zoom",
  "addressdetails"
]);

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/geocode/search") {
      return proxyGeocode(request, url, "search", SEARCH_PARAMETERS, env, context);
    }

    if (url.pathname === "/geocode/reverse") {
      return proxyGeocode(request, url, "reverse", REVERSE_PARAMETERS, env, context);
    }

    return env.ASSETS.fetch(request);
  }
};

export class NominatimLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
    this.nextRequestAt = 0;
    this.ctx.blockConcurrencyWhile(async () => {
      this.nextRequestAt = await this.ctx.storage.get("nextRequestAt") || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== NOMINATIM_URL) {
      return jsonError("Invalid upstream request.", 400);
    }

    const pending = this.queue.then(() => this.forward(request));
    this.queue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async forward(request) {
    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const responsePromise = fetch(request);
    this.nextRequestAt = Date.now() + NOMINATIM_INTERVAL_MS;
    await this.ctx.storage.put("nextRequestAt", this.nextRequestAt);
    return responsePromise;
  }
}

async function proxyGeocode(request, requestUrl, endpoint, allowedParameters, env, context) {
  if (request.method !== "GET") {
    return jsonError("Method not allowed.", 405, { Allow: "GET" });
  }

  const upstreamUrl = new URL(endpoint, `${NOMINATIM_URL}/`);
  for (const [name, value] of requestUrl.searchParams) {
    if (allowedParameters.has(name)) {
      upstreamUrl.searchParams.set(name, value);
    }
  }

  const validationError = validateRequest(endpoint, upstreamUrl.searchParams);
  if (validationError) {
    return jsonError(validationError, 400);
  }

  upstreamUrl.searchParams.set("format", "jsonv2");
  if (endpoint === "search") {
    upstreamUrl.searchParams.set("limit", "6");
  }

  const language = request.headers.get("accept-language")?.slice(0, 80);
  if (language) {
    upstreamUrl.searchParams.set("accept-language", language);
  }

  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: "GET" });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  let upstreamResponse;
  try {
    const upstreamRequest = new Request(upstreamUrl, {
      headers: {
        Accept: "application/json",
        Referer: APPLICATION_URL,
        "User-Agent": `Tauschaktionen-Finder/1.0 (${APPLICATION_URL})`
      }
    });
    const limiter = env.NOMINATIM_LIMITER.getByName("global");
    upstreamResponse = await limiter.fetch(upstreamRequest, {
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    return jsonError("Geocoding service unavailable.", 502);
  }

  if (!upstreamResponse.ok) {
    return jsonError("Geocoding service unavailable.", 502);
  }

  const headers = new Headers(upstreamResponse.headers);
  headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.delete("Set-Cookie");

  const response = new Response(upstreamResponse.body, {
    status: 200,
    headers
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function validateRequest(endpoint, parameters) {
  if (endpoint === "search") {
    const query = parameters.get("q")?.trim();
    if (!query || query.length > 200) {
      return "A search term between 1 and 200 characters is required.";
    }
    return null;
  }

  const latitude = Number(parameters.get("lat"));
  const longitude = Number(parameters.get("lon"));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return "A valid latitude is required.";
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return "A valid longitude is required.";
  }
  return null;
}

function jsonError(message, status, extraHeaders = {}) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders
      }
    }
  );
}
