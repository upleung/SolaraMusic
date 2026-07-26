const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init) {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  headers.set("Access-Control-Allow-Origin", "*");
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return headers;
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname) {
  return hostname && KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl, request) {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) return new Response("Invalid target", { status: 400 });

  const init = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) init.headers["Range"] = rangeHeader;

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url, request, waitUntil, apiBaseUrl) {
  const cache = caches.default;

  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");

  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const bypassCache = url.searchParams.get("nocache") === "true";

  if (request.method === "GET" && !bypassCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      response.headers.set("X-Cache-Status", "HIT");
      response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
      return response;
    }
  }

  const apiUrl = new URL(apiBaseUrl);

  // 手动提取 source（关键修复点）
  const source = url.searchParams.get("source") || "netease";
  apiUrl.searchParams.set("source", source);

  // 复制其他参数
  url.searchParams.forEach((value, key) => {
    if (["target", "callback", "s", "nocache", "source"].includes(key)) return;
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  const isSearch = url.searchParams.get("types") === "search";
  const isEmpty = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');

  let shouldCache = upstream.status === 200 && !isError && !bypassCache;
  if (isSearch && isEmpty) shouldCache = false;

  if (shouldCache) {
    headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
  } else {
    headers.set("Cache-Control", "no-store");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }) {
  const apiBaseUrl = env?.API_BASE_URL || DEFAULT_API_BASE_URL;

  if (request.method === "OPTIONS") return handleOptions();
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) return proxyKuwoAudio(target, request);

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
