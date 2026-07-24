import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createCachedFetch } from './cached-fetch.js';
import { loadConfig } from './config.js';
import { downsample16kTo8k, pcmDurationMs, upsample8kTo16k } from './audio.js';
import {
  AUDIO_SOCKET_KIND,
  AudioSocketParser,
  encodeAudioSocketFrame,
  uuidBytesToString,
} from './audio-socket.js';
import { summarizeLatency } from './latency.js';
import { createRealEstateBot } from './real-estate-bot.js';
import { WavRecorder } from './wav.js';

const config = loadConfig();
const sessions = new Set();
const botFetch = createCachedFetch(globalThis.fetch, { ttlMs: config.botPreloadCacheMs });
let botPreloadedAt = 0;
let botPreloadPromise;

const server = net.createServer((socket) => {
  const session = new CallSession(socket, config);
  sessions.add(session);
  session.done.finally(() => sessions.delete(session));
});

server.on('error', (error) => {
  log('error', 'AudioSocket server error', { error: error.message });
  process.exitCode = 1;
});

const readinessServer = http.createServer(async (request, response) => {
  if (request.method !== 'GET' || !['/prepare', '/ready'].includes(request.url)) {
    response.writeHead(404).end('not found');
    return;
  }
  if (request.url === '/ready') {
    const ready = isBotPreloaded();
    response.writeHead(ready ? 200 : 503).end(ready ? 'ready' : 'warming');
    return;
  }
  try {
    await ensureBotPreloaded();
    response.writeHead(200).end('ready');
  } catch (error) {
    log('error', 'Bot preload failed', { error: error.message });
    response.writeHead(503).end('error');
  }
});

readinessServer.on('error', (error) => {
  log('error', 'Readiness server error', { error: error.message });
  process.exit(1);
});

readinessServer.listen(config.readinessPort, config.readinessHost, () => {
  log('info', 'Readiness server listening', {
    address: `${config.readinessHost}:${config.readinessPort}`,
  });
  ensureBotPreloaded().catch((error) => {
    log('error', 'Initial bot preload failed', { error: error.message });
  });
});

server.listen(config.port, config.host, () => {
  log('info', 'GoIP bridge listening', {
    address: `${config.host}:${config.port}`,
    mode: config.mode,
    callMaxSeconds: config.callMaxSeconds,
    recordCalls: config.recordCalls,
    latencyMonitoring: config.latencyMonitoring,
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log('info', 'Shutting down', { signal, activeCalls: sessions.size });
    server.close();
    readinessServer.close();
    for (const session of sessions) session.close(`process_${signal.toLowerCase()}`);
    setTimeout(() => process.exit(0), 250).unref();
  });
}

class CallSession {
  constructor(socket, callConfig) {
    this.socket = socket;
    this.config = callConfig;
    this.parser = new AudioSocketParser();
    this.callId = undefined;
    this.recorder = undefined;
    this.ws = undefined;
    this.wsReady = false;
    this.geminiReady = false;
    this.proxySetup = undefined;
    this.bot = undefined;
    this.botClient = undefined;
    this.botStarted = false;
    this.closed = false;
    this.sequenceNumber = 0;
    this.mediaChunk = 1;
    this.mediaTimestamp = 0;
    this.inputAudioDurationMs = 0;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.playbackQueue = [];
    this.playbackBytes = 0;
    this.playbackTimer = undefined;
    this.maxDurationTimer = undefined;
    this.proxyPingTimer = undefined;
    this.proxyPingStartedAt = undefined;
    this.proxyPingTimeouts = 0;
    this.proxyRttSamples = [];
    this.latestProxyRttMs = undefined;
    this.lastInputFrameAt = undefined;
    this.inputFrameGaps = [];
    this.inputFrameGapsOver40Ms = 0;
    this.playbackResponseIndex = 0;
    this.activePlayback = undefined;
    this.resolveDone = undefined;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onAudioSocketData(chunk));
    socket.on('end', () => this.close('audiosocket_end'));
    socket.on('close', () => this.close('audiosocket_closed'));
    socket.on('error', (error) => {
      log('warn', 'AudioSocket connection error', this.fields({ error: error.message }));
      this.close('audiosocket_error');
    });
  }

  onAudioSocketData(chunk) {
    try {
      for (const frame of this.parser.push(chunk)) this.onAudioSocketFrame(frame);
    } catch (error) {
      log('warn', 'Invalid AudioSocket frame', this.fields({ error: error.message }));
      this.close('invalid_audiosocket_frame');
    }
  }

  onAudioSocketFrame({ kind, payload }) {
    if (this.closed) return;
    if (kind === AUDIO_SOCKET_KIND.UUID) {
      if (this.callId) return this.close('duplicate_uuid');
      this.callId = uuidBytesToString(payload);
      if (this.config.recordCalls) {
        this.recorder = new WavRecorder({
          directory: this.config.recordingsDir,
          basename: this.callId,
          sampleRate: 16_000,
        });
      }
      log('info', 'Call started', this.fields());
      if (this.config.callMaxSeconds > 0) {
        this.maxDurationTimer = setTimeout(
          () => this.close('max_duration'),
          this.config.callMaxSeconds * 1000,
        );
        this.maxDurationTimer.unref();
      }
      if (this.config.mode === 'proxy') {
        this.prepareProxy().catch((error) => {
          log('error', 'Failed to prepare AI session', this.fields({ error: error.message }));
          this.close('bot_setup_error');
        });
      }
      return;
    }

    if (kind === AUDIO_SOCKET_KIND.PCM16_8K) {
      if (!this.callId) return this.close('audio_before_uuid');
      this.trackAudioSocketInputFrame();
      const pcm16k = upsample8kTo16k(payload);
      this.inputAudioDurationMs += pcmDurationMs(pcm16k, 16_000);
      this.recorder?.append(pcm16k);
      if (this.config.mode === 'proxy') this.sendOrQueueAudio(pcm16k);
      return;
    }

    if (kind === AUDIO_SOCKET_KIND.DTMF) {
      log('info', 'DTMF received', this.fields({ digit: payload.toString('ascii') }));
      return;
    }

    if (kind === AUDIO_SOCKET_KIND.TERMINATE) return this.close('remote_hangup');
    if (kind === AUDIO_SOCKET_KIND.ERROR) {
      return this.close(`asterisk_error_${payload.toString('hex') || 'unknown'}`);
    }

    log('debug', 'Ignoring AudioSocket frame', this.fields({ kind, bytes: payload.length }));
  }

  async prepareProxy() {
    if (this.config.botProfile === 'real-estate') {
      this.bot = configuredRealEstateBot((fields) => this.fields(fields));
      this.proxySetup = await this.bot.initialize();
      this.discardPendingAudio('bot_preload');
    } else {
      this.proxySetup = {
        model: this.config.geminiModel,
        config: {
          responseModalities: ['AUDIO'],
          systemInstruction: this.config.systemInstruction
            ? { parts: [{ text: this.config.systemInstruction }] }
            : undefined,
        },
      };
    }
    if (!this.closed) this.connectProxy();
  }

  connectProxy() {
    const ws = new WebSocket(this.config.proxyWsUrl, {
      headers: { Authorization: `Bearer ${this.config.proxySharedToken}` },
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.closed) return ws.close();
      this.wsReady = true;
      this.botClient = this.bot?.createClient(
        (packet) => this.sendProxyPacket(packet),
        () => this.clearPlayback('interrupted'),
      );
      this.sendProxyPacket({
        customEvent: 'gemini',
        setup: {
          model: this.proxySetup.model,
          config: this.proxySetup.config,
        },
        metadata: { callId: this.callId, source: 'goip-audiosocket-bridge' },
      });
      this.sendProxyPacket({
        event: 'start',
        sequenceNumber: this.sequenceNumber++,
        streamId: this.callId,
        start: {
          streamId: this.callId,
          mediaFormat: { encoding: 'audio/L16', sampleRate: 16_000, channels: 1 },
          customParameters: { source: 'goip' },
        },
      });
      log('info', 'Proxy WebSocket connected', this.fields());
      this.startProxyLatencyMonitoring();
    });

    ws.on('pong', () => this.onProxyPong());
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        log('warn', 'Ignoring unexpected binary proxy message', this.fields());
        return;
      }
      this.onProxyMessage(data.toString());
    });
    ws.on('close', (code, reason) => {
      this.wsReady = false;
      this.geminiReady = false;
      if (!this.closed) {
        log('warn', 'Proxy WebSocket closed', this.fields({
          code,
          reason: reason.toString(),
        }));
        this.close('proxy_closed');
      }
    });
    ws.on('error', (error) => {
      log('warn', 'Proxy WebSocket error', this.fields({ error: error.message }));
      if (!this.closed) this.close('proxy_error');
    });
  }

  onProxyMessage(text) {
    let packet;
    try {
      packet = JSON.parse(text);
    } catch {
      log('warn', 'Ignoring invalid proxy JSON', this.fields());
      return;
    }

    if (packet.event === 'media' && typeof packet.media?.payload === 'string') {
      try {
        const receivedAt = Date.now();
        const pcm16k = Buffer.from(packet.media.payload, 'base64');
        this.queuePlayback(downsample16kTo8k(pcm16k), receivedAt);
      } catch (error) {
        log('warn', 'Invalid proxy media packet', this.fields({ error: error.message }));
        this.close('invalid_proxy_media');
      }
      return;
    }

    if (packet.event === 'stop') {
      log('info', 'Proxy media stopped', this.fields());
      return;
    }

    if (packet.customEvent !== 'gemini') return;
    if (packet.proxyError) {
      log('warn', 'Proxy session error', this.fields({ proxyError: packet.proxyError }));
      return this.close('proxy_session_error');
    }
    if (packet.proxyClosed) {
      log('info', 'Proxy session closed', this.fields({ proxyClosed: packet.proxyClosed }));
      return;
    }
    const serverMessage = packet.serverMessage || {};
    if (serverMessage.serverContent?.turnComplete) {
      this.markPlaybackTurnComplete();
    }
    this.bot?.handleServerMessage(serverMessage, this.botClient);

    const initialText = this.bot?.initialText || this.config.initialText;
    if (serverMessage.setupComplete && !this.geminiReady) {
      this.geminiReady = true;
      this.discardPendingAudio('gemini_setup');
      if (initialText) {
        this.sendProxyPacket({
          customEvent: 'gemini',
          realtimeInput: { text: initialText },
        });
      }
      if (this.bot && !this.botStarted) {
        this.botStarted = true;
        this.bot.startWatchdogs(this.botClient, (reason) => this.close(reason));
      }
      log('info', 'Gemini session ready', this.fields());
    }
  }

  sendOrQueueAudio(pcm16k) {
    if (this.wsReady && this.geminiReady) return this.sendMediaPacket(pcm16k);
    if (this.pendingAudioBytes + pcm16k.length > this.config.maxPendingAudioBytes) {
      return this.close('pending_audio_overflow');
    }
    this.pendingAudio.push(pcm16k);
    this.pendingAudioBytes += pcm16k.length;
  }

  discardPendingAudio(reason) {
    if (!this.pendingAudioBytes) return;
    log('info', 'Discarding pre-session audio', this.fields({
      reason,
      bytes: this.pendingAudioBytes,
      durationMs: Math.round(this.pendingAudioBytes / 32),
    }));
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  sendMediaPacket(pcm16k) {
    this.sendProxyPacket({
      event: 'media',
      sequenceNumber: this.sequenceNumber++,
      streamId: this.callId,
      media: {
        chunk: this.mediaChunk++,
        timestamp: Math.round(this.mediaTimestamp),
        payload: pcm16k.toString('base64'),
      },
    });
    this.mediaTimestamp += pcmDurationMs(pcm16k, 16_000);
  }

  sendProxyPacket(packet) {
    if (!this.wsReady || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(packet));
    return true;
  }

  queuePlayback(pcm8k, receivedAt = Date.now()) {
    if (this.playbackBytes + pcm8k.length > this.config.maxPlaybackAudioBytes) {
      return this.close('playback_audio_overflow');
    }
    if (!this.activePlayback) {
      this.activePlayback = {
        response: ++this.playbackResponseIndex,
        firstProxyMediaAt: receivedAt,
        firstAudioSocketWriteAt: undefined,
        turnCompleteAt: undefined,
        framesReceived: 0,
        framesWritten: 0,
        bytesReceived: 0,
        bytesWritten: 0,
        queuePeakBytes: 0,
        audioSocketWritablePeakBytes: 0,
      };
      log('info', 'Bot audio arrived from proxy', this.fields({
        response: this.activePlayback.response,
        proxyRttMs: this.latestProxyRttMs,
        estimatedProxyOneWayMs: estimateOneWay(this.latestProxyRttMs),
      }));
    }
    this.playbackQueue.push(pcm8k);
    this.playbackBytes += pcm8k.length;
    this.activePlayback.framesReceived += 1;
    this.activePlayback.bytesReceived += pcm8k.length;
    this.activePlayback.queuePeakBytes = Math.max(
      this.activePlayback.queuePeakBytes,
      this.playbackBytes,
    );
    if (!this.playbackTimer) {
      this.playbackTimer = setInterval(() => this.flushPlaybackFrame(), 20);
      this.playbackTimer.unref();
    }
  }

  clearPlayback(reason = 'cleared') {
    const droppedBytes = this.playbackBytes;
    this.playbackQueue = [];
    this.playbackBytes = 0;
    if (this.playbackTimer) clearInterval(this.playbackTimer);
    this.playbackTimer = undefined;
    this.finishPlayback(reason, { droppedAudioMs: audioBytesDurationMs(droppedBytes, 8_000) });
  }

  flushPlaybackFrame() {
    if (this.closed || this.socket.destroyed) return;
    const frame = this.playbackQueue.shift();
    if (!frame) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = undefined;
      if (this.activePlayback?.turnCompleteAt) this.finishPlayback('turn_complete');
      return;
    }
    this.playbackBytes -= frame.length;
    const now = Date.now();
    const playback = this.activePlayback;
    if (playback && !playback.firstAudioSocketWriteAt) {
      playback.firstAudioSocketWriteAt = now;
      log('info', 'Bot audio sent to AudioSocket', this.fields({
        response: playback.response,
        proxyMediaToAudioSocketMs: now - playback.firstProxyMediaAt,
        queuedAudioMs: audioBytesDurationMs(this.playbackBytes + frame.length, 8_000),
        proxyRttMs: this.latestProxyRttMs,
        estimatedProxyOneWayMs: estimateOneWay(this.latestProxyRttMs),
      }));
    }
    const accepted = this.socket.write(
      encodeAudioSocketFrame(AUDIO_SOCKET_KIND.PCM16_8K, frame),
    );
    if (playback) {
      playback.framesWritten += 1;
      playback.bytesWritten += frame.length;
      playback.audioSocketWritablePeakBytes = Math.max(
        playback.audioSocketWritablePeakBytes,
        this.socket.writableLength,
      );
    }
    if (!accepted) {
      log('warn', 'AudioSocket write backpressure', this.fields({
        response: playback?.response,
        writableBytes: this.socket.writableLength,
      }));
    }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.playbackTimer) clearInterval(this.playbackTimer);
    if (this.proxyPingTimer) clearInterval(this.proxyPingTimer);
    this.finishPlayback('call_closed', {
      droppedAudioMs: audioBytesDurationMs(this.playbackBytes, 8_000),
    });
    this.bot?.shutdown(reason);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        event: 'stop',
        sequenceNumber: this.sequenceNumber++,
        streamId: this.callId,
        stop: { reason },
      }));
      this.ws.send(JSON.stringify({ customEvent: 'gemini', close: {} }));
      this.ws.close(1000, reason.slice(0, 120));
    } else {
      this.ws?.terminate();
    }

    if (!this.socket.destroyed) {
      this.socket.end(encodeAudioSocketFrame(AUDIO_SOCKET_KIND.TERMINATE));
      setTimeout(() => {
        if (!this.socket.destroyed) this.socket.destroy();
      }, 100).unref();
    }

    const durationMs = Math.round(this.inputAudioDurationMs);
    const recorderPromise = this.recorder
      ? this.recorder.close().then((filePath) => {
        log('info', 'Recording saved', this.fields({ filePath }));
      }).catch((error) => {
        log('error', 'Failed to save recording', this.fields({ error: error.message }));
      })
      : Promise.resolve();

    log('info', 'Call latency summary', this.fields({
      proxyWebSocketRtt: summarizeLatency(this.proxyRttSamples),
      proxyPingTimeouts: this.proxyPingTimeouts,
      audioSocketInputFrameGap: summarizeLatency(this.inputFrameGaps),
      audioSocketInputGapsOver40Ms: this.inputFrameGapsOver40Ms,
    }));
    log('info', 'Call finished', this.fields({ reason, audioDurationMs: durationMs }));
    recorderPromise.finally(() => this.resolveDone());
  }

  startProxyLatencyMonitoring() {
    if (!this.config.latencyMonitoring || this.proxyPingTimer || !this.wsReady) return;
    this.sendProxyPing();
    this.proxyPingTimer = setInterval(
      () => this.sendProxyPing(),
      this.config.proxyPingIntervalMs,
    );
    this.proxyPingTimer.unref();
  }

  sendProxyPing() {
    if (!this.wsReady || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this.proxyPingStartedAt !== undefined) {
      if (now - this.proxyPingStartedAt < this.config.proxyPingIntervalMs * 2) return;
      this.proxyPingTimeouts += 1;
      log('warn', 'Proxy WebSocket ping timed out', this.fields({
        timeoutMs: now - this.proxyPingStartedAt,
      }));
    }
    this.proxyPingStartedAt = now;
    try {
      this.ws.ping();
    } catch (error) {
      this.proxyPingStartedAt = undefined;
      log('warn', 'Failed to ping proxy WebSocket', this.fields({ error: error.message }));
    }
  }

  onProxyPong() {
    if (this.proxyPingStartedAt === undefined) return;
    const rttMs = Date.now() - this.proxyPingStartedAt;
    this.proxyPingStartedAt = undefined;
    this.latestProxyRttMs = rttMs;
    this.proxyRttSamples.push(rttMs);
    log('info', 'Proxy WebSocket RTT', this.fields({
      proxyRttMs: rttMs,
      estimatedOneWayMs: estimateOneWay(rttMs),
    }));
  }

  trackAudioSocketInputFrame(receivedAt = Date.now()) {
    if (!this.config.latencyMonitoring) return;
    if (this.lastInputFrameAt !== undefined) {
      const gapMs = receivedAt - this.lastInputFrameAt;
      this.inputFrameGaps.push(gapMs);
      if (gapMs > 40) this.inputFrameGapsOver40Ms += 1;
    }
    this.lastInputFrameAt = receivedAt;
  }

  markPlaybackTurnComplete(receivedAt = Date.now()) {
    if (!this.activePlayback) return;
    this.activePlayback.turnCompleteAt = receivedAt;
    if (this.playbackQueue.length === 0) this.finishPlayback('turn_complete');
  }

  finishPlayback(reason, extra = {}) {
    const playback = this.activePlayback;
    if (!playback) return;
    const now = Date.now();
    log('info', 'Bot audio playback summary', this.fields({
      response: playback.response,
      reason,
      proxyMediaToAudioSocketMs: playback.firstAudioSocketWriteAt === undefined
        ? undefined
        : playback.firstAudioSocketWriteAt - playback.firstProxyMediaAt,
      localPlaybackElapsedMs: playback.firstAudioSocketWriteAt === undefined
        ? undefined
        : now - playback.firstAudioSocketWriteAt,
      receivedAudioMs: audioBytesDurationMs(playback.bytesReceived, 8_000),
      writtenAudioMs: audioBytesDurationMs(playback.bytesWritten, 8_000),
      queuePeakMs: audioBytesDurationMs(playback.queuePeakBytes, 8_000),
      audioSocketWritablePeakBytes: playback.audioSocketWritablePeakBytes,
      proxyRttMs: this.latestProxyRttMs,
      estimatedProxyOneWayMs: estimateOneWay(this.latestProxyRttMs),
      ...extra,
    }));
    this.activePlayback = undefined;
  }

  fields(extra = {}) {
    return { callId: this.callId, ...extra };
  }
}

function configuredRealEstateBot(fields = (extra) => extra) {
  return createRealEstateBot({
    geminiModel: config.geminiModel,
    voiceName: config.botVoiceName,
    pageUrl: config.botPageUrl,
    dateUtcOffset: config.botDateUtcOffset,
    allowConfirmBooking: config.allowConfirmBooking,
    maxCallDurationMs: config.botMaxCallDurationMs,
    fetchImpl: botFetch,
    log: (level, message, extra) => log(level, message, fields(extra)),
  });
}

function isBotPreloaded() {
  if (config.mode !== 'proxy' || config.botProfile !== 'real-estate') return true;
  return Date.now() - botPreloadedAt < config.botPreloadCacheMs;
}

async function ensureBotPreloaded() {
  if (isBotPreloaded()) return;
  if (botPreloadPromise) return botPreloadPromise;

  botPreloadPromise = (async () => {
    const bot = configuredRealEstateBot((fields) => ({ preload: true, ...fields }));
    try {
      await bot.initialize();
      botPreloadedAt = Date.now();
      log('info', 'Real-estate data preloaded', {
        cacheMs: config.botPreloadCacheMs,
      });
    } finally {
      bot.shutdown('preload');
    }
  })().finally(() => {
    botPreloadPromise = undefined;
  });
  return botPreloadPromise;
}

function log(level, message, fields = {}) {
  const line = { timestamp: new Date().toISOString(), level, message, ...fields };
  const output = level === 'error' || level === 'warn' ? console.error : console.log;
  output(JSON.stringify(line));
}

function audioBytesDurationMs(bytes, sampleRate) {
  return Math.round((bytes * 1000) / (2 * sampleRate));
}

function estimateOneWay(rttMs) {
  return Number.isFinite(rttMs) ? Math.round(rttMs / 2) : undefined;
}
