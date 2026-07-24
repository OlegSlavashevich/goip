import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealEstateBot } from '../src/real-estate-bot.js';

test('real-estate scenario builds its prompt and four Gemini tools', async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).includes('/assist/')) {
      return response(`
        <html>
          <script>
            initWidgetSearch({token: "test-token", apartments: [101]})
            initWidgetList({token: "test-token", apartments: [101]})
          </script>
        </html>
      `);
    }
    if (String(url).endsWith('/info.json')) return response('{}');
    if (String(url).endsWith('/apartments')) return response('{"apartments":[]}');
    throw new Error(`Unexpected URL: ${url}`);
  };

  const bot = createRealEstateBot({
    geminiModel: 'gemini-test',
    fetchImpl,
  });
  const setup = await bot.initialize();
  const declarations = setup.config.tools[0].functionDeclarations;

  assert.equal(setup.model, 'gemini-test');
  assert.equal(bot.bookingMode, 'dry-run');
  assert.deepEqual(
    declarations.map(({ name }) => name),
    [
      'search_apartments',
      'check_apartment_availability',
      'get_apartment_detail',
      'create_booking_request',
    ],
  );
  assert.match(
    setup.config.systemInstruction.parts[0].text,
    /Сервис «Как Дома»|сервиса "Как Дома"/,
  );
  assert.ok(requestedUrls.some((url) => url.endsWith('/apartments')));

  const sentPackets = [];
  let playbackCleared = false;
  const client = bot.createClient(
    (packet) => sentPackets.push(packet),
    () => {
      playbackCleared = true;
    },
  );
  bot.handleServerMessage({
    serverContent: { interrupted: true },
    toolCall: {
      functionCalls: [{ id: 'call-1', name: 'unknown_test_tool', args: {} }],
    },
  }, client);
  await eventually(() => sentPackets.some((packet) => packet.toolResponse));

  assert.equal(playbackCleared, true);
  assert.match(
    sentPackets[0].toolResponse.functionResponses[0].response.output.error,
    /Unknown function/,
  );
  bot.shutdown('test');
});

function response(body, status = 200) {
  return {
    status,
    async text() {
      return body;
    },
  };
}

async function eventually(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
