const { Router } = require('express');
const cache = require('../cache');

const API_BASE_URL = process.env.API_BASE_URL || 'https://music-api.gdstudio.xyz/api.php';
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

const SAFE_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'accept-ranges',
  'content-length', 'content-range', 'etag', 'last-modified', 'expires',
];

function isAllowedKuwoHost(hostname) {
  return hostname && KUWO_HOST_PATTERN.test(hostname);
}

function buildCacheKey(url) {
  const u = new URL(url);
  u.searchParams.delete('s');
  u.searchParams.delete('nocache');
  return u.toString();
}

/**
 * 核心修复点：规范化 source 参数
 * 将前端传来的 source 智能映射到第三方 API 支持的规范参数
 * 支持 API 文档中规定的 netease、tencent、kuwo、tidal、qobuz、joox、bilibili、apple、ytmusic、spotify
 * 同时保留对于 "_album" 的高级用法支持。
 */
function normalizeSource(rawSource) {
  if (!rawSource) return 'netease';
  
  let s = String(rawSource).toLowerCase().trim();
  let suffix = '';
  
  // 保留获取专辑时的 _album 后缀
  if (s.endsWith('_album')) {
    suffix = '_album';
    s = s.replace('_album', '');
  }

  // 映射字典，支持模糊匹配与准确转换
  if (s.includes('qq') || s === 'tencent') s = 'tencent';
  else if (s.includes('youtube') || s === 'ytmusic' || s === 'yt') s = 'ytmusic';
  else if (s.includes('apple')) s = 'apple';
  else if (s.includes('bilibili') || s === 'b站') s = 'bilibili';
  else if (s.includes('spotify')) s = 'spotify';
  else if (s.includes('tidal')) s = 'tidal';
  else if (s.includes('qobuz')) s = 'qobuz';
  else if (s.includes('kuwo')) s = 'kuwo';
  else if (s.includes('joox')) s = 'joox';
  else if (s.includes('netease') || s.includes('网易')) s = 'netease';

  return s + suffix;
}

async function proxyKuwoAudio(targetUrl, req, res) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid target');
  }

  if (!isAllowedKuwoHost(parsed.hostname)) {
    return res.status(400).send('Invalid target');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).send('Invalid target');
  }
  parsed.protocol = 'http:';

  const headers = {
    'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
    'Referer': 'https://www.kuwo.cn/',
  };
  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(parsed.toString(), {
      method: req.method,
      headers,
      signal: controller.signal
    });

    res.status(upstream.status);
    for (const h of SAFE_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const { Readable } = require('node:stream');
    return Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Proxy Kuwo]', err);
    return res.status(502).send('Upstream error');
  }
}

async function proxyApiRequest(reqUrl, req, res) {
  const cacheKey = buildCacheKey(reqUrl);
  const parsedReq = new URL(reqUrl);
  const bypassCache = parsedReq.searchParams.get('nocache') === 'true';

  if (!bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
      return res.send(cached.body);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${reqUrl}`);

  const apiUrl = new URL(API_BASE_URL);

  // ⭐⭐ 应用修复：解析并规范化 source 参数后写入 API URL ⭐⭐
  const rawSource = parsedReq.searchParams.get("source");
  const normalizedSource = normalizeSource(rawSource);
  apiUrl.searchParams.set("source", normalizedSource);

  // 复制其他参数，透传给上游 API
  parsedReq.searchParams.forEach((value, key) => {
    if (['target', 'callback', 's', 'nocache', 'source'].includes(key)) return;
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has('types')) {
    return res.status(400).send('Missing types');
  }

  let upstream;
  let responseText;
  let contentType;

  try {
    upstream = await fetch(apiUrl.toString(), {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });
    responseText = await upstream.text();
    contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  } catch (err) {
    console.error('[Proxy API fetch]', err);
    return res.status(502).send('Upstream error');
  }

  const isSearch = parsedReq.searchParams.get('types') === 'search';
  const isEmpty = responseText.trim() === '[]';
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');

  let shouldCache = upstream.status === 200 && !isError && !bypassCache;
  if (isSearch && isEmpty) shouldCache = false;

  if (shouldCache) {
    cache.set(cacheKey, { body: responseText, contentType }, 300);
    console.log(`[Cache PUT] Saved to cache: ${reqUrl}`);
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Cache-Status', 'MISS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache-Status');
  res.setHeader('Cache-Control', shouldCache ? 'public, max-age=300' : 'no-store');

  return res.status(upstream.status).send(responseText);
}

module.exports = function createProxyRouter() {
  const router = Router();

  router.options('/', (req, res) => {
    res.status(204)
      .set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      })
      .end();
  });

  router.get('/', async (req, res) => {
    const target = req.query.target;

    if (target) {
      return proxyKuwoAudio(target, req, res);
    }

    // 构建完整请求 URL，保留原始参数用于代理逻辑
    const fullUrl = `http://localhost${req.originalUrl}`;
    return proxyApiRequest(fullUrl, req, res);
  });

  return router;
};
