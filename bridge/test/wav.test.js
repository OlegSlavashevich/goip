import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWavHeader } from '../src/wav.js';

test('WAV header describes PCM16 mono 16 kHz audio', () => {
  const header = makeWavHeader(32_000, 16_000);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16_000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 32_000);
});

