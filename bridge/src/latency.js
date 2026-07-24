export function summarizeLatency(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return undefined;
  const sorted = samples
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;

  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    samples: sorted.length,
    minMs: Math.round(sorted[0]),
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
    averageMs: Math.round(total / sorted.length),
  };
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}
