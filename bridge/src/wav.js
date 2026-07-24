import fs from 'node:fs/promises';
import path from 'node:path';

export class WavRecorder {
  #chunks = [];
  #bytes = 0;
  #closed = false;

  constructor({ directory, basename, sampleRate = 16_000 }) {
    this.directory = directory;
    this.basename = safeBasename(basename);
    this.sampleRate = sampleRate;
    this.filePath = path.join(directory, `${this.basename}.wav`);
  }

  append(pcm) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) {
      throw new Error('WAV recorder accepts only PCM16 buffers');
    }
    this.#chunks.push(Buffer.from(pcm));
    this.#bytes += pcm.length;
  }

  async close() {
    if (this.#closed) return this.filePath;
    this.#closed = true;
    await fs.mkdir(this.directory, { recursive: true });
    const header = makeWavHeader(this.#bytes, this.sampleRate);
    await fs.writeFile(this.filePath, Buffer.concat([header, ...this.#chunks]));
    this.#chunks = [];
    return this.filePath;
  }
}

export function makeWavHeader(dataBytes, sampleRate = 16_000) {
  const channels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function safeBasename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'call';
}

