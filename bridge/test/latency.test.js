import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeLatency } from '../src/latency.js';

test('latency summary reports nearest-rank percentiles', () => {
  assert.deepEqual(summarizeLatency([10, 30, 20, 100]), {
    samples: 4,
    minMs: 10,
    p50Ms: 20,
    p95Ms: 100,
    maxMs: 100,
    averageMs: 40,
  });
});

test('latency summary ignores invalid samples', () => {
  assert.deepEqual(summarizeLatency([Number.NaN, -1, 12.4]), {
    samples: 1,
    minMs: 12,
    p50Ms: 12,
    p95Ms: 12,
    maxMs: 12,
    averageMs: 12,
  });
  assert.equal(summarizeLatency([]), undefined);
});
