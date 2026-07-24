export function loadConfig(env = process.env) {
  const mode = env.BRIDGE_MODE || 'record';
  if (!['record', 'proxy'].includes(mode)) {
    throw new Error('BRIDGE_MODE must be "record" or "proxy"');
  }

  const config = {
    host: env.AUDIO_SOCKET_HOST || '0.0.0.0',
    port: integer(env.AUDIO_SOCKET_PORT, 9092, 'AUDIO_SOCKET_PORT', 1),
    mode,
    callMaxSeconds: integer(env.CALL_MAX_SECONDS, 10, 'CALL_MAX_SECONDS', 0),
    recordCalls: boolean(env.RECORD_CALLS, true),
    recordingsDir: env.RECORDINGS_DIR || './recordings',
    proxyWsUrl: env.PROXY_WS_URL || '',
    proxySharedToken: env.PROXY_SHARED_TOKEN || '',
    geminiModel: env.GEMINI_MODEL || '',
    systemInstruction: env.SYSTEM_INSTRUCTION || '',
    initialText: env.INITIAL_TEXT || '',
    botProfile: env.BOT_PROFILE || 'real-estate',
    botPageUrl: env.BOT_PAGE_URL || 'https://kakdoma-sutochno.ru/assist/',
    botDateUtcOffset: env.BOT_DATE_UTC_OFFSET || '+03:00',
    botVoiceName: env.BOT_VOICE_NAME || 'Erinome',
    allowConfirmBooking: boolean(env.ALLOW_CONFIRM_BOOKING, false),
    botMaxCallDurationMs: integer(
      env.BOT_MAX_CALL_DURATION_MS,
      1_200_000,
      'BOT_MAX_CALL_DURATION_MS',
      0,
    ),
    maxPendingAudioBytes: integer(
      env.MAX_PENDING_AUDIO_BYTES,
      1_048_576,
      'MAX_PENDING_AUDIO_BYTES',
      640,
    ),
    maxPlaybackAudioBytes: integer(
      env.MAX_PLAYBACK_AUDIO_BYTES,
      1_048_576,
      'MAX_PLAYBACK_AUDIO_BYTES',
      320,
    ),
  };

  if (mode === 'proxy') {
    if (!['simple', 'real-estate'].includes(config.botProfile)) {
      throw new Error('BOT_PROFILE must be "simple" or "real-estate"');
    }
    for (const [name, value] of [
      ['PROXY_WS_URL', config.proxyWsUrl],
      ['PROXY_SHARED_TOKEN', config.proxySharedToken],
      ['GEMINI_MODEL', config.geminiModel],
    ]) {
      if (!value) throw new Error(`${name} is required in BRIDGE_MODE=proxy`);
    }
    const url = new URL(config.proxyWsUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('PROXY_WS_URL must use ws:// or wss://');
    }
  }

  return config;
}

function integer(raw, fallback, name, minimum) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function boolean(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}
