const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "accept-ranges",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "expires"
];

function createCorsHeaders(init?: Headers | [string, string][] | Record<string, string>) {
  const headers = new Headers();
  if (init) {
    const entries = init instanceof Headers ? init.entries() : Object.entries(init);
    for (const [key, value] of entries) {
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

function isAllowedKuwoHost(hostname: string) {
  return hostname && KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string) {
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

async function proxyKuwoAudio(targetUrl: string, request: Request) {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) return new Response("Invalid target", { status: 400 });

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    } as Record<string, string>,
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) (init.headers as Record<string, string>)["Range"] = rangeHeader;

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * 核心修复点：
 * 将前端传来的 source (例如 "QQ音乐", "Apple Music", "YouTube Music")
 * 智能映射到第三方 API 支持的规范参数 (如 "tencent", "apple", "ytmusic")。
 * 同时保留对于 "_album" 的高级用法支持。
 */
function normalizeSource(rawSource: string | null): string {
  if (!rawSource) return "netease";
  
  let s = rawSource.toLowerCase().trim();
  let suffix = "";
  
  // 保留获取专辑时的 _album 后缀
  if (s.endsWith("_album")) {
    suffix = "_album";
    s = s.replace("_album", "");
  }

  // 映射字典，支持模糊匹配与准确转换
  if (s.includes("qq") || s === "tencent") s = "tencent";
  else if (s.includes("youtube") || s === "ytmusic" || s === "yt") s = "ytmusic";
  else if (s.includes("apple")) s = "apple";
  else if (s.includes("bilibili") || s === "b站") s = "bilibili";
  else if (s.includes("spotify")) s = "spotify";
  else if (s.includes("tidal")) s = "tidal";
  else if (s.includes("qobuz")) s = "qobuz";
  else if (s.includes("kuwo")) s = "kuwo";
  else if (s.includes("joox")) s = "joox";
  else if (s.includes("netease") || s.includes("网易")) s = "netease";

  return s + suffix;
}

async function proxyApiRequest(url: URL, request: Request, waitUntil: (promise: Promise<any>) => void, apiBaseUrl: string) {
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

  // 解析并规范化 source 参数后注入 API 接口
  const source = normalizeSource(url.searchParams.get("source"));
  apiUrl.searchParams.set("source", source);

  // 复制并透传其他参数（types, name, count, pages, id, br, size 等）
  url.searchParams.forEach((value, key) => {
    if (["target", "callback", "s", "nocache", "source"].includes(key)) return;
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types parameter", { status: 400 });
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

export async function onRequest({ request, waitUntil, env }: any) {
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
