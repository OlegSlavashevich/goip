import assert from 'node:assert/strict';
import test from 'node:test';
import { PreparedCallRegistry } from '../src/prepared-calls.js';

test('concurrent prepare calls share one session and claim it once', async () => {
  let created = 0;
  let prepared = 0;
  const session = {
    async prepareBeforeAnswer() {
      prepared += 1;
    },
    close() {},
  };
  const registry = new PreparedCallRegistry({ ttlMs: 1_000 });
  const create = () => {
    created += 1;
    return session;
  };

  const [first, second] = await Promise.all([
    registry.prepare('call-1', create),
    registry.prepare('call-1', create),
  ]);

  assert.equal(first, session);
  assert.equal(second, session);
  assert.equal(created, 1);
  assert.equal(prepared, 1);
  assert.equal(registry.claim('call-1'), session);
  assert.equal(registry.claim('call-1'), undefined);
});

test('unclaimed prepared session expires', async () => {
  let closeReason;
  const registry = new PreparedCallRegistry({ ttlMs: 10 });
  await registry.prepare('call-2', () => ({
    async prepareBeforeAnswer() {},
    close(reason) {
      closeReason = reason;
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(registry.size, 0);
  assert.equal(closeReason, 'prepare_expired');
});

test('failed preparation is removed and closed', async () => {
  let closeReason;
  const registry = new PreparedCallRegistry({ ttlMs: 1_000 });

  await assert.rejects(
    registry.prepare('call-3', () => ({
      async prepareBeforeAnswer() {
        throw new Error('greeting failed');
      },
      close(reason) {
        closeReason = reason;
      },
    })),
    /greeting failed/,
  );

  assert.equal(registry.size, 0);
  assert.equal(registry.claim('call-3'), undefined);
  assert.equal(closeReason, 'prepare_failed');
});

test('prepared session that closes before claim is removed', async () => {
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const session = {
    done,
    async prepareBeforeAnswer() {},
    close() {},
  };
  const registry = new PreparedCallRegistry({ ttlMs: 1_000 });

  await registry.prepare('call-4', () => session);
  finish();
  await done;
  await Promise.resolve();

  assert.equal(registry.size, 0);
  assert.equal(registry.claim('call-4'), undefined);
});
