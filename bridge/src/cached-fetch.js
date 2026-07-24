export function createCachedFetch(fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is required');
  const ttlMs = options.ttlMs ?? 300_000;
  const cache = new Map();
  const inFlight = new Map();

  return async function cachedFetch(url, request = {}) {
    const key = cacheKey(url, request);
    if (!key) return fetchImpl(url, request);

    const cached = cache.get(key);
    if (cached && Date.now() - cached.savedAt < ttlMs) {
      return createResponse(cached.status, cached.body);
    }

    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchAndCache(fetchImpl, url, request, cache, key)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const result = await pending;
    return createResponse(result.status, result.body);
  };
}

async function fetchAndCache(fetchImpl, url, request, cache, key) {
  const response = await fetchImpl(url, request);
  const result = {
    status: response.status,
    body: await response.text(),
    savedAt: Date.now(),
  };
  if (result.status >= 200 && result.status < 300) cache.set(key, result);
  return result;
}

function cacheKey(url, request) {
  const method = String(request.method || 'GET').toUpperCase();
  const address = String(url);
  if (method === 'GET' && (
    address.includes('/assist/')
    || address.endsWith('/info.json')
  )) {
    return `${method} ${address}`;
  }

  if (method !== 'POST' || !address.endsWith('/apartments')) return undefined;
  try {
    const body = JSON.parse(request.body || request.postData || '{}');
    if (body.begin_date !== null || body.end_date !== null) return undefined;
    return `${method} ${address} ${JSON.stringify(body)}`;
  } catch {
    return undefined;
  }
}

function createResponse(status, body) {
  return {
    status,
    async text() {
      return body;
    },
  };
}
