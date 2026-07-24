/**
 * AudioSocket supplies little-endian signed PCM16 at 8 kHz. The existing
 * ai-websocket-proxy expects the Voximplant PCM16 format at 16 kHz.
 *
 * GSM audio is narrow-band already, so zero-order interpolation is sufficient
 * for this transport adapter and, importantly, does not alter frame timing.
 */
export function upsample8kTo16k(input) {
  assertPcm16(input);
  const output = Buffer.allocUnsafe(input.length * 2);
  let outputOffset = 0;
  for (let offset = 0; offset < input.length; offset += 2) {
    const sample = input.readInt16LE(offset);
    output.writeInt16LE(sample, outputOffset);
    output.writeInt16LE(sample, outputOffset + 2);
    outputOffset += 4;
  }
  return output;
}

/**
 * Downsample by averaging adjacent samples. Averaging is a small low-pass
 * filter and is safer than discarding every second sample.
 */
export function downsample16kTo8k(input) {
  assertPcm16(input);
  if (input.length % 4 !== 0) {
    throw new Error(`16 kHz PCM byte length must be divisible by 4, got ${input.length}`);
  }
  const output = Buffer.allocUnsafe(input.length / 2);
  let outputOffset = 0;
  for (let offset = 0; offset < input.length; offset += 4) {
    const first = input.readInt16LE(offset);
    const second = input.readInt16LE(offset + 2);
    output.writeInt16LE(Math.round((first + second) / 2), outputOffset);
    outputOffset += 2;
  }
  return output;
}

export function pcmDurationMs(buffer, sampleRate) {
  assertPcm16(buffer);
  return (buffer.length / 2 / sampleRate) * 1000;
}

function assertPcm16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length % 2 !== 0) {
    throw new Error('PCM16 audio must be a Buffer with an even byte length');
  }
}

