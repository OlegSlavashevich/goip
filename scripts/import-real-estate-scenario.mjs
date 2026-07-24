import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(repositoryRoot, '../ai-websocket-proxy/examples/scenario_proxy.js');
const outputPath = path.resolve(repositoryRoot, 'bridge/src/real-estate-bot.js');
const marker = '/*\n * Drop-in transport adapter';

const source = await readFile(sourcePath, 'utf8');
const markerIndex = source.indexOf(marker);
if (markerIndex === -1) {
  throw new Error(`Could not find Voximplant adapter marker in ${sourcePath}`);
}

let core = source.slice(0, markerIndex)
  .replace(/^require\(Modules\.[^)]+\);\s*$/gm, '')
  .replace(
    'const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";',
    'const GEMINI_MODEL = options.geminiModel || "gemini-2.5-flash-native-audio-preview-12-2025";',
  )
  .replace(
    'const VOICE_NAME = "Erinome";',
    'const VOICE_NAME = options.voiceName || "Erinome";',
  )
  .replace(
    'const PAGE_URL = "https://kakdoma-sutochno.ru/assist/";',
    'const PAGE_URL = options.pageUrl || "https://kakdoma-sutochno.ru/assist/";',
  )
  .replace(
    'const DATE_UTC_OFFSET = "+03:00";',
    'const DATE_UTC_OFFSET = options.dateUtcOffset || "+03:00";',
  )
  .replace(
    'const ALLOW_CONFIRM_BOOKING = true;',
    'const ALLOW_CONFIRM_BOOKING = options.allowConfirmBooking === true;',
  );

const generated = `// Generated from ai-websocket-proxy/examples/scenario_proxy.js.
// Re-run scripts/import-real-estate-scenario.mjs after changing the source scenario.

export function createRealEstateBot(options = {}) {
  const Logger = {
    write(line) {
      if (typeof options.log === "function") options.log("info", "Real-estate bot", { line });
    },
  };
  const Net = {
    httpRequestAsync: createHttpRequestAdapter(options.fetchImpl || globalThis.fetch),
  };

${indent(core.trim(), 2)}

  function timeout(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  ACTIVE_CALL_METRICS = createCallMetrics();
  SESSION_SHUTTING_DOWN = false;
  let runtime = null;
  let watchdogTimer = null;
  let maxDurationTimer = null;

  async function initialize({ callerPhone } = {}) {
    setStage("preloading");
    runtime = await loadRuntimeConfig(PAGE_URL);
    const rawCallerPhone = String(callerPhone || "");
    runtime.callerPhone = isValidPhone(rawCallerPhone) ? rawCallerPhone : null;
    runtime.voiceState = {
      lastActivityAt: Date.now(),
      lastInputAt: 0,
      lastOutputAt: 0,
      playbackEndEstimate: 0,
      nudgeCount: 0,
      farewellAt: 0,
      toolInFlight: false,
    };
    setStage("gemini_ready");
    return {
      model: GEMINI_MODEL,
      config: buildGeminiConfig(runtime),
    };
  }

  function createClient(sendPacket, clearMediaBuffer) {
    return {
      sendRealtimeInput(input) {
        sendPacket({ customEvent: "gemini", realtimeInput: input || {} });
      },
      sendToolResponse(input) {
        sendPacket({
          customEvent: "gemini",
          toolResponse: input || { functionResponses: [] },
        });
      },
      clearMediaBuffer() {
        if (typeof clearMediaBuffer === "function") clearMediaBuffer();
      },
    };
  }

  function handleServerMessage(serverMessage, client) {
    if (!runtime) return;
    const content = serverMessage.serverContent || {};

    if (content.inputTranscription) {
      const payload = content.inputTranscription;
      runtime.voiceState.lastActivityAt = Date.now();
      runtime.voiceState.lastInputAt = Date.now();
      runtime.voiceState.nudgeCount = 0;
      runtime.voiceState.farewellAt = 0;
      if (payload.text) log("input", payload.text, { finished: !!payload.finished });
    }

    if (content.outputTranscription) {
      const payload = content.outputTranscription;
      const text = String(payload.text || "");
      runtime.voiceState.lastActivityAt = Date.now();
      runtime.voiceState.lastOutputAt = Date.now();
      runtime.voiceState.playbackEndEstimate =
        Math.max(runtime.voiceState.playbackEndEstimate, Date.now()) + text.length * 90;
      if (text) log("output", text, { finished: !!payload.finished });
    }

    if (content.interrupted) {
      runtime.voiceState.playbackEndEstimate = Date.now();
      client.clearMediaBuffer();
    }

    if (serverMessage.toolCall) {
      handleToolCall(client, runtime, {
        data: { payload: serverMessage.toolCall },
      }).catch(function (error) {
        log("tool", "handler error", String((error && error.message) || error));
      });
    }

    if (serverMessage.toolCallCancellation) {
      log("tool", "cancel requested", serverMessage.toolCallCancellation);
    }
    if (serverMessage.usageMetadata) handleUsagePayload(serverMessage.usageMetadata);
    if (content.turnComplete) {
      log("gemini", "turn complete", { reason: content.turnCompleteReason });
    }
    if (serverMessage.goAway) {
      log("proxy", "gemini goAway", serverMessage.goAway);
      client.sendRealtimeInput({
        text: "Служебное сообщение: сессия скоро завершится. Вежливо заверши разговор одной короткой фразой.",
      });
    }
  }

  function startWatchdogs(client, onMaxDuration) {
    watchdogTimer = setInterval(function () {
      const state = runtime && runtime.voiceState;
      if (!state || state.toolInFlight || SESSION_SHUTTING_DOWN) return;
      const now = Date.now();
      const idleSince = Math.max(state.lastActivityAt, state.playbackEndEstimate || 0);
      const idleMs = now - idleSince;
      if (state.nudgeCount >= 2) {
        if (idleMs > 40000 && !state.farewellAt) {
          state.farewellAt = now;
          client.sendRealtimeInput({
            text: "Служебное сообщение: клиент не ответил. Коротко попрощайся.",
          });
          const hangupTimer = setTimeout(function () {
            if (!SESSION_SHUTTING_DOWN && runtime.voiceState.nudgeCount >= 2) {
              onMaxDuration("silence_timeout");
            }
          }, 8000);
          hangupTimer.unref?.();
        }
        return;
      }
      if (idleMs <= 12000) return;
      state.nudgeCount += 1;
      state.lastActivityAt = now;
      client.sendRealtimeInput({
        text: "Служебное сообщение: в разговоре тишина. Если ждёшь ответа — коротко повтори вопрос; иначе мягко спроси, слышно ли тебя.",
      });
    }, 5000);
    watchdogTimer.unref?.();

    const maxDurationMs = Number(options.maxCallDurationMs || MAX_CALL_DURATION_MS);
    if (maxDurationMs > 0) {
      maxDurationTimer = setTimeout(function () {
        if (SESSION_SHUTTING_DOWN) return;
        client.sendRealtimeInput({
          text: "Служебное сообщение: достигнут лимит звонка. Коротко подведи итог и попрощайся.",
        });
        const hangupTimer = setTimeout(function () {
          if (!SESSION_SHUTTING_DOWN) onMaxDuration("bot_max_duration");
        }, 15000);
        hangupTimer.unref?.();
      }, maxDurationMs);
      maxDurationTimer.unref?.();
    }
  }

  function shutdown(reason) {
    if (SESSION_SHUTTING_DOWN) return;
    SESSION_SHUTTING_DOWN = true;
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    logCallSummary(reason);
  }

  return {
    initialize,
    createClient,
    handleServerMessage,
    startWatchdogs,
    shutdown,
    bookingMode: ALLOW_CONFIRM_BOOKING ? "live" : "dry-run",
    initialText:
      'Начни разговор сейчас ровно этой фразой: "Здравствуйте! Сервис «Как Дома», посуточная аренда квартир. Чем могу помочь?"',
    get runtime() {
      return runtime;
    },
  };
}

function createHttpRequestAdapter(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch API implementation is required");
  }
  return async function httpRequestAsync(url, request = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    timer.unref?.();
    try {
      const headers = {};
      for (const rawHeader of request.headers || []) {
        const separator = rawHeader.indexOf(":");
        if (separator === -1) continue;
        headers[rawHeader.slice(0, separator).trim()] = rawHeader.slice(separator + 1).trim();
      }
      const response = await fetchImpl(url, {
        method: request.method || "GET",
        headers,
        body: request.postData,
        signal: controller.signal,
      });
      return {
        code: response.status,
        text: await response.text(),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
`;

await writeFile(outputPath, generated);
console.log(`Imported ${sourcePath} -> ${outputPath}`);

function indent(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}
