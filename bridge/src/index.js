import net from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { downsample16kTo8k, pcmDurationMs, upsample8kTo16k } from './audio.js';
import {
  AUDIO_SOCKET_KIND,
  AudioSocketParser,
  encodeAudioSocketFrame,
  uuidBytesToString,
} from './audio-socket.js';
import { WavRecorder } from './wav.js';

const config = loadConfig();
const sessions = new Set();

const server = net.createServer((socket) => {
  const session = new CallSession(socket, config);
  sessions.add(session);
  session.done.finally(() => sessions.delete(session));
});

server.on('error', (error) => {
  log('error', 'AudioSocket server error', { error: error.message });
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  log('info', 'GoIP bridge listening', {
    address: `${config.host}:${config.port}`,
    mode: config.mode,
    callMaxSeconds: config.callMaxSeconds,
    recordCalls: config.recordCalls,
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log('info', 'Shutting down', { signal, activeCalls: sessions.size });
    server.close();
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
      if (this.config.mode === 'proxy') this.connectProxy();
      return;
    }

    if (kind === AUDIO_SOCKET_KIND.PCM16_8K) {
      if (!this.callId) return this.close('audio_before_uuid');
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
      this.sendProxyPacket({
        customEvent: 'gemini',
        setup: {
          model: this.config.geminiModel,
          config: {
            responseModalities: ['AUDIO'],
            systemInstruction: this.config.systemInstruction
              ? { parts: [{ text: this.config.systemInstruction }] }
              : undefined,
          },
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
      for (const audio of this.pendingAudio) this.sendMediaPacket(audio);
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      log('info', 'Proxy WebSocket connected', this.fields());
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        log('warn', 'Ignoring unexpected binary proxy message', this.fields());
        return;
      }
      this.onProxyMessage(data.toString());
    });
    ws.on('close', (code, reason) => {
      this.wsReady = false;
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
        const pcm16k = Buffer.from(packet.media.payload, 'base64');
        this.queuePlayback(downsample16kTo8k(pcm16k));
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
    if (packet.serverMessage?.setupComplete && this.config.initialText) {
      this.sendProxyPacket({
        customEvent: 'gemini',
        realtimeInput: { text: this.config.initialText },
      });
      log('info', 'Gemini session ready', this.fields());
    }
  }

  sendOrQueueAudio(pcm16k) {
    if (this.wsReady) return this.sendMediaPacket(pcm16k);
    if (this.pendingAudioBytes + pcm16k.length > this.config.maxPendingAudioBytes) {
      return this.close('pending_audio_overflow');
    }
    this.pendingAudio.push(pcm16k);
    this.pendingAudioBytes += pcm16k.length;
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

  queuePlayback(pcm8k) {
    if (this.playbackBytes + pcm8k.length > this.config.maxPlaybackAudioBytes) {
      return this.close('playback_audio_overflow');
    }
    this.playbackQueue.push(pcm8k);
    this.playbackBytes += pcm8k.length;
    if (!this.playbackTimer) {
      this.playbackTimer = setInterval(() => this.flushPlaybackFrame(), 20);
      this.playbackTimer.unref();
    }
  }

  flushPlaybackFrame() {
    if (this.closed || this.socket.destroyed) return;
    const frame = this.playbackQueue.shift();
    if (!frame) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = undefined;
      return;
    }
    this.playbackBytes -= frame.length;
    this.socket.write(encodeAudioSocketFrame(AUDIO_SOCKET_KIND.PCM16_8K, frame));
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.playbackTimer) clearInterval(this.playbackTimer);

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

    log('info', 'Call finished', this.fields({ reason, audioDurationMs: durationMs }));
    recorderPromise.finally(() => this.resolveDone());
  }

  fields(extra = {}) {
    return { callId: this.callId, ...extra };
  }
}

function log(level, message, fields = {}) {
  const line = { timestamp: new Date().toISOString(), level, message, ...fields };
  const output = level === 'error' || level === 'warn' ? console.error : console.log;
  output(JSON.stringify(line));
}
