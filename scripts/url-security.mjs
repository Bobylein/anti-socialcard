import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const blockedAddresses = createBlockedAddressList();
const publicIpv6Addresses = createPublicIpv6AddressList();

export function normalizeHttpUrl(value, { baseUrl, path = "URL" } = {}) {
  let url;
  try {
    url = new URL(String(value), baseUrl);
  } catch {
    throw new Error(`${path}: invalid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${path}: only http/https allowed`);
  }
  if (url.username || url.password) {
    throw new Error(`${path}: credentials are not allowed`);
  }
  return url.toString();
}

export function isPublicIpAddress(address, family = isIP(address)) {
  const normalized = stripIpv6Brackets(address);
  const resolvedFamily = family || isIP(normalized);
  if (resolvedFamily !== 4 && resolvedFamily !== 6) return false;
  if (resolvedFamily === 6 && !publicIpv6Addresses.check(normalized, "ipv6")) return false;
  return !blockedAddresses.check(normalized, resolvedFamily === 4 ? "ipv4" : "ipv6");
}

export async function fetchPublicWebsite(
  value,
  {
    method = "HEAD",
    timeoutMs = 10000,
    lookupImpl = dnsLookup,
    requestImpl,
    redirects = 0
  } = {}
) {
  const url = new URL(normalizeHttpUrl(value, { path: "Website" }));
  if (redirects > MAX_REDIRECTS) throw new Error("Website: too many redirects");
  const addresses = await resolvePublicAddresses(url.hostname, lookupImpl);
  const transport = requestImpl ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
  const response = await requestOnce(url, addresses, { method, timeoutMs, transport });
  const location = response.headers.location;

  if (REDIRECT_STATUSES.has(response.status) && location) {
    const redirectUrl = normalizeHttpUrl(location, { baseUrl: url, path: "Website redirect" });
    return fetchPublicWebsite(redirectUrl, {
      method: response.status === 303 ? "GET" : method,
      timeoutMs,
      lookupImpl,
      requestImpl,
      redirects: redirects + 1
    });
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    url: url.toString()
  };
}

export async function resolvePublicAddresses(hostname, lookupImpl = dnsLookup) {
  const normalizedHostname = stripIpv6Brackets(hostname);
  const literalFamily = isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily }]
    : await lookupImpl(normalizedHostname, { all: true, verbatim: true });

  if (!addresses.length) throw new Error("Website: hostname did not resolve");
  for (const entry of addresses) {
    const family = Number(entry.family) || isIP(entry.address);
    if (!isPublicIpAddress(entry.address, family)) {
      throw new Error("Website: private or reserved network target blocked");
    }
  }
  return addresses.map((entry) => ({
    address: stripIpv6Brackets(entry.address),
    family: Number(entry.family) || isIP(entry.address)
  })).sort((left, right) => left.family - right.family);
}

function requestOnce(url, addresses, { method, timeoutMs, transport }) {
  return new Promise((resolve, reject) => {
    const request = transport(url, {
      method,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "Anti-SocialCard.de updater; link freshness check",
        ...(method === "GET" ? { range: "bytes=0-0" } : {})
      },
      lookup(hostname, options, callback) {
        const requestedFamily = Number(options?.family) || 0;
        const selected = addresses.find((entry) => !requestedFamily || entry.family === requestedFamily);
        if (!selected) {
          callback(new Error(`Website: no approved IPv${requestedFamily} address for ${hostname}`));
          return;
        }
        callback(null, selected.address, selected.family);
      }
    }, (response) => {
      const result = {
        status: response.statusCode ?? 0,
        headers: response.headers
      };
      response.destroy();
      resolve(result);
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error("Website check timed out");
      error.name = "TimeoutError";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end();
  });
}

function stripIpv6Brackets(value) {
  return String(value).replace(/^\[|\]$/g, "");
}

function createBlockedAddressList() {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ]) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8]
  ]) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

function createPublicIpv6AddressList() {
  const list = new BlockList();
  list.addSubnet("2000::", 3, "ipv6");
  return list;
}
