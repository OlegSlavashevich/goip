export class PreparedCallRegistry {
  constructor({ ttlMs, log = () => {} }) {
    this.ttlMs = ttlMs;
    this.log = log;
    this.entries = new Map();
  }

  prepare(callId, createSession) {
    const existing = this.entries.get(callId);
    if (existing) return existing.ready;

    const session = createSession();
    const entry = {
      session,
      timer: undefined,
      ready: undefined,
    };
    session.done?.finally(() => {
      if (this.entries.get(callId) !== entry) return;
      this.entries.delete(callId);
      if (entry.timer) clearTimeout(entry.timer);
    });
    entry.ready = Promise.resolve()
      .then(() => session.prepareBeforeAnswer())
      .then(() => {
        if (this.entries.get(callId) === entry) {
          entry.timer = setTimeout(() => {
            if (this.entries.get(callId) !== entry) return;
            this.entries.delete(callId);
            this.log('warn', 'Prepared call expired', { callId, ttlMs: this.ttlMs });
            session.close('prepare_expired');
          }, this.ttlMs);
          entry.timer.unref?.();
        }
        return session;
      })
      .catch((error) => {
        if (this.entries.get(callId) === entry) this.entries.delete(callId);
        if (entry.timer) clearTimeout(entry.timer);
        session.close('prepare_failed');
        throw error;
      });
    this.entries.set(callId, entry);
    return entry.ready;
  }

  claim(callId) {
    const entry = this.entries.get(callId);
    if (!entry) return undefined;
    this.entries.delete(callId);
    if (entry.timer) clearTimeout(entry.timer);
    this.log('info', 'Prepared call claimed', { callId });
    return entry.session;
  }

  closeAll(reason = 'registry_shutdown') {
    for (const [callId, entry] of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.session.close(reason);
      this.log('info', 'Prepared call closed', { callId, reason });
    }
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
