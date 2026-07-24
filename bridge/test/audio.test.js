import assert from 'node:assert/strict';
import test from 'node:test';
import { downsample16kTo8k, pcmDurationMs, upsample8kTo16k } from '../src/audio.js';

test('8 kHz PCM is doubled into 16 kHz PCM without changing duration', () => {
  const input = Buffer.alloc(320);
  for (let offset = 0; offset < input.length; offset += 2) {
    input.writeInt16LE(offset / 2, offset);
  }
  const output = upsample8kTo16k(input);
  assert.equal(output.length, 640);
  assert.equal(pcmDurationMs(input, 8_000), 20);
  assert.equal(pcmDurationMs(output, 16_000), 20);
  assert.equal(output.readInt16LE(0), output.readInt16LE(2));
});

test('16 kHz PCM is averaged into 8 kHz PCM', () => {
  const input = Buffer.alloc(8);
  input.writeInt16LE(100, 0);
  input.writeInt16LE(300, 2);
  input.writeInt16LE(-100, 4);
  input.writeInt16LE(-300, 6);
  const output = downsample16kTo8k(input);
  assert.equal(output.length, 4);
  assert.equal(output.readInt16LE(0), 200);
  assert.equal(output.readInt16LE(2), -200);
});
