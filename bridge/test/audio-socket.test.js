import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIO_SOCKET_KIND,
  AudioSocketParser,
  encodeAudioSocketFrame,
  uuidBytesToString,
} from '../src/audio-socket.js';

test('AudioSocket parser handles fragmented and combined frames', () => {
  const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const first = encodeAudioSocketFrame(AUDIO_SOCKET_KIND.UUID, uuid);
  const second = encodeAudioSocketFrame(AUDIO_SOCKET_KIND.PCM16_8K, Buffer.alloc(320, 7));
  const wire = Buffer.concat([first, second]);
  const parser = new AudioSocketParser();

  assert.deepEqual(parser.push(wire.subarray(0, 5)), []);
  const frames = parser.push(wire.subarray(5));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, AUDIO_SOCKET_KIND.UUID);
  assert.equal(frames[1].payload.length, 320);
});

test('binary UUID is rendered in canonical form', () => {
  const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  assert.equal(uuidBytesToString(uuid), '00112233-4455-6677-8899-aabbccddeeff');
});

