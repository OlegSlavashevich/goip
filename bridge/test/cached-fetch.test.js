import assert from 'node:assert/strict';
import test from 'node:test';
import { createCachedFetch } from '../src/cached-fetch.js';

test('preload requests are cached while dated searches are not', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return response(`response-${requests}`);
  };
  const fetchCached = createCachedFetch(fetchImpl, { ttlMs: 60_000 });

  assert.equal(await body(fetchCached('https://example.test/assist/')), 'response-1');
  assert.equal(await body(fetchCached('https://example.test/assist/')), 'response-1');

  const preload = {
    method: 'POST',
    body: JSON.stringify({ begin_date: null, end_date: null }),
  };
  assert.equal(
    await body(fetchCached('https://example.test/apartments', preload)),
    'response-2',
  );
  assert.equal(
    await body(fetchCached('https://example.test/apartments', preload)),
    'response-2',
  );

  const search = {
    method: 'POST',
    body: JSON.stringify({ begin_date: '2026-08-01', end_date: '2026-08-03' }),
  };
  assert.equal(
    await body(fetchCached('https://example.test/apartments', search)),
    'response-3',
  );
  assert.equal(
    await body(fetchCached('https://example.test/apartments', search)),
    'response-4',
  );
});

async function body(responsePromise) {
  return (await responsePromise).text();
}

function response(text) {
  return {
    status: 200,
    async text() {
      return text;
    },
  };
}
