export class SseHub {
  constructor({ heartbeatMs = 20_000, pollTimeoutMs = 15_000, maxEvents = 2_048, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.clients = new Set();
    this.waiters = new Set();
    this.events = [];
    this.eventBytes = 0;
    this.cursor = 0;
    this.pollTimeoutMs = pollTimeoutMs;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.timer = setInterval(() => this.#writeSse({ kind: "heartbeat", at: Date.now() }), heartbeatMs);
    this.timer.unref();
  }

  connect(req, res, initialState, cursor = null) {
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    this.clients.add(res);
    if (cursor !== null) {
      const replay = this.#eventsAfter(cursor);
      if (replay.reset) {
        res.write(this.#ssePayload({ kind: "transport_reset" }, replay.nextCursor));
      } else {
        for (const entry of replay.events) res.write(this.#ssePayload(entry.event, entry.cursor));
      }
    }
    res.write(this.#ssePayload({ kind: "connected", ...initialState }, this.cursor));
    req.on("close", () => this.clients.delete(res));
  }

  broadcast(event) {
    const serialized = JSON.stringify(event);
    const entry = { cursor: ++this.cursor, event, bytes: Buffer.byteLength(serialized) };
    this.events.push(entry);
    this.eventBytes += entry.bytes;
    while (this.events.length > this.maxEvents || this.eventBytes > this.maxBytes) {
      this.eventBytes -= this.events.shift().bytes;
    }
    this.#writeSse(event, entry.cursor, serialized);
    for (const waiter of [...this.waiters]) this.#resolveWaiter(waiter);
  }

  poll(cursor, signal) {
    const immediate = this.#eventsAfter(cursor);
    if (cursor === null || immediate.reset || immediate.events.length > 0) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const waiter = { cursor, resolve, signal, timer: null, onAbort: null };
      waiter.onAbort = () => this.#finishWaiter(waiter, null);
      waiter.timer = setTimeout(() => this.#finishWaiter(waiter, this.#eventsAfter(cursor)), this.pollTimeoutMs);
      waiter.timer.unref?.();
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.add(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  close() {
    clearInterval(this.timer);
    for (const waiter of [...this.waiters]) this.#finishWaiter(waiter, null);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  #eventsAfter(cursor) {
    if (cursor === null) return { events: [], nextCursor: this.cursor, reset: false };
    const firstCursor = this.events[0]?.cursor ?? this.cursor + 1;
    if (cursor < firstCursor - 1) return { events: [], nextCursor: this.cursor, reset: true };
    return {
      events: this.events.filter((entry) => entry.cursor > cursor).map(({ cursor: eventCursor, event }) => ({ cursor: eventCursor, event })),
      nextCursor: this.cursor,
      reset: false,
    };
  }

  #resolveWaiter(waiter) {
    const result = this.#eventsAfter(waiter.cursor);
    if (result.reset || result.events.length > 0) this.#finishWaiter(waiter, result);
  }

  #finishWaiter(waiter, result) {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(result);
  }

  #writeSse(event, cursor = null, serialized = JSON.stringify(event)) {
    const payload = this.#ssePayload(event, cursor, serialized);
    for (const client of this.clients) client.write(payload);
  }

  #ssePayload(event, cursor = null, serialized = JSON.stringify(event)) {
    return `${cursor === null ? "" : `id: ${cursor}\n`}data: ${serialized}\n\n`;
  }
}
