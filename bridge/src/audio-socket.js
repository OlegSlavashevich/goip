export const AUDIO_SOCKET_KIND = Object.freeze({
  TERMINATE: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  PCM16_8K: 0x10,
  ERROR: 0xff,
});

export class AudioSocketParser {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('AudioSocket data must be a Buffer');
    this.#buffer = this.#buffer.length === 0
      ? chunk
      : Buffer.concat([this.#buffer, chunk]);

    const frames = [];
    while (this.#buffer.length >= 3) {
      const payloadLength = this.#buffer.readUInt16BE(1);
      const frameLength = 3 + payloadLength;
      if (this.#buffer.length < frameLength) break;
      frames.push({
        kind: this.#buffer[0],
        payload: this.#buffer.subarray(3, frameLength),
      });
      this.#buffer = this.#buffer.subarray(frameLength);
    }
    return frames;
  }
}

export function encodeAudioSocketFrame(kind, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) throw new TypeError('AudioSocket payload must be a Buffer');
  if (payload.length > 0xffff) throw new RangeError('AudioSocket payload is too large');
  const header = Buffer.allocUnsafe(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  return payload.length === 0 ? header : Buffer.concat([header, payload]);
}

export function uuidBytesToString(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new Error(`AudioSocket UUID must contain 16 bytes, got ${bytes?.length ?? 0}`);
  }
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

