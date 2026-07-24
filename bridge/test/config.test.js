import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('real-estate bot is the safe default in proxy mode', () => {
  const config = loadConfig({
    BRIDGE_MODE: 'proxy',
    PROXY_WS_URL: 'wss://proxy.example.test/v1/live',
    PROXY_SHARED_TOKEN: 'secret',
    GEMINI_MODEL: 'gemini-test',
  });

  assert.equal(config.botProfile, 'real-estate');
  assert.equal(config.allowConfirmBooking, false);
  assert.equal(config.botPageUrl, 'https://kakdoma-sutochno.ru/assist/');
});

test('live booking must be explicitly enabled', () => {
  const config = loadConfig({
    BRIDGE_MODE: 'proxy',
    PROXY_WS_URL: 'wss://proxy.example.test/v1/live',
    PROXY_SHARED_TOKEN: 'secret',
    GEMINI_MODEL: 'gemini-test',
    ALLOW_CONFIRM_BOOKING: 'true',
  });

  assert.equal(config.allowConfirmBooking, true);
});
