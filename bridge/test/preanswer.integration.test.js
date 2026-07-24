import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  AUDIO_SOCKET_KIND,
  AudioSocketParser,
  encodeAudioSocketFrame,
} from '../src/audio-socket.js';

const bridgeDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('prepares greeting audio before AudioSocket attaches', { timeout: 10_000 }, async (t) => {
  let audioSocketPort;
  try {
    audioSocketPort = await unusedPort();
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    t.skip('local TCP listeners are unavailable in this sandbox');
    return;
  }
  const readinessPort = await unusedPort();
  const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => proxy.once('listening', resolve));
  const proxyPort = proxy.address().port;
  const proxyPackets = [];

  proxy.on('connection', (socket) => {
    socket.on('message', (data) => {
      const packet = JSON.parse(data.toString());
      proxyPackets.push(packet);
      if (packet.customEvent === 'gemini' && packet.setup) {
        socket.send(JSON.stringify({
          customEvent: 'gemini',
          serverMessage: { setupComplete: {} },
        }));
      }
      if (packet.customEvent === 'gemini' && packet.realtimeInput?.text) {
        socket.send(JSON.stringify({
          event: 'media',
          media: { payload: Buffer.alloc(640, 7).toString('base64') },
        }));
      }
    });
  });

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: bridgeDirectory,
    env: {
      ...process.env,
      AUDIO_SOCKET_HOST: '127.0.0.1',
      AUDIO_SOCKET_PORT: String(audioSocketPort),
      READINESS_HOST: '127.0.0.1',
      READINESS_PORT: String(readinessPort),
      BRIDGE_MODE: 'proxy',
      PROXY_WS_URL: `ws://127.0.0.1:${proxyPort}`,
      PROXY_SHARED_TOKEN: 'integration-test',
      GEMINI_MODEL: 'integration-test',
      BOT_PROFILE: 'simple',
      INITIAL_TEXT: 'Say hello',
      RECORD_CALLS: 'false',
      CALL_MAX_SECONDS: '0',
      LATENCY_MONITORING: 'false',
      PREPARE_AI_TIMEOUT_MS: '3000',
      PREPARED_CALL_TTL_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => {
    childOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    childOutput += chunk.toString();
  });

  let audioSocket;
  try {
    await waitUntil(() => childOutput.includes('Readiness server listening'));
    const callId = '00112233-4455-4677-8899-aabbccddeeff';
    const response = await fetch(
      `http://127.0.0.1:${readinessPort}/prepare?callId=${callId}`,
    );
    assert.equal(response.status, 200, childOutput);
    assert.equal(await response.text(), 'ready');
    assert.ok(
      proxyPackets.some((packet) => packet.event === 'start'),
      'proxy media stream must start before the phone call is answered',
    );

    audioSocket = net.connect(audioSocketPort, '127.0.0.1');
    await new Promise((resolve, reject) => {
      audioSocket.once('connect', resolve);
      audioSocket.once('error', reject);
    });
    audioSocket.write(encodeAudioSocketFrame(
      AUDIO_SOCKET_KIND.UUID,
      Buffer.from(callId.replaceAll('-', ''), 'hex'),
    ));

    const frame = await nextAudioSocketFrame(audioSocket, AUDIO_SOCKET_KIND.PCM16_8K);
    assert.equal(frame.payload.length, 320);
    await waitUntil(() => childOutput.includes('"answerToFirstBotAudioMs"'));
    assert.match(childOutput, /"preparedBeforeAnswer":true/);
  } finally {
    audioSocket?.destroy();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    for (const socket of proxy.clients) socket.terminate();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function nextAudioSocketFrame(socket, kind) {
  const parser = new AudioSocketParser();
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      try {
        const frame = parser.push(chunk).find((candidate) => candidate.kind === kind);
        if (!frame) return;
        cleanup();
        resolve(frame);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('AudioSocket closed before the expected frame arrived'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.on('close', onClose);
  });
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
