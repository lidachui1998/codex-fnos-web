import assert from "node:assert/strict";
import test from "node:test";
import { SseHub } from "../sse-hub.mjs";

test("SSE events carry cursors and remain available to polling clients", async () => {
  const hub = new SseHub({ heartbeatMs: 60_000, pollTimeoutMs: 20, maxEvents: 2 });
  try {
    assert.deepEqual(await hub.poll(null), { events: [], nextCursor: 0, reset: false });
    hub.broadcast({ kind: "first" });
    hub.broadcast({ kind: "second" });
    assert.deepEqual(await hub.poll(0), {
      events: [
        { cursor: 1, event: { kind: "first" } },
        { cursor: 2, event: { kind: "second" } },
      ],
      nextCursor: 2,
      reset: false,
    });

    hub.broadcast({ kind: "third" });
    assert.deepEqual(await hub.poll(0), { events: [], nextCursor: 3, reset: true });
  } finally {
    hub.close();
  }
});

test("long polling resolves when a new event is broadcast", async () => {
  const hub = new SseHub({ heartbeatMs: 60_000, pollTimeoutMs: 100 });
  try {
    const pending = hub.poll(0);
    hub.broadcast({ kind: "notification", method: "turn/started" });
    assert.deepEqual(await pending, {
      events: [{ cursor: 1, event: { kind: "notification", method: "turn/started" } }],
      nextCursor: 1,
      reset: false,
    });
  } finally {
    hub.close();
  }
});

test("SSE clients receive the same cursor as polling clients", async () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const writes = [];
  const req = { on() {} };
  const res = {
    writeHead(status, headers) { writes.push({ status, headers }); },
    write(value) { writes.push(value); },
    end() {},
  };
  try {
    hub.connect(req, res, { bridge: { status: "ready" } });
    hub.broadcast({ kind: "turn" });
    assert.equal(writes[0].status, 200);
    assert.match(writes[1], /^id: 0\ndata: .*"connected"/);
    assert.equal(writes[2], "id: 1\ndata: {\"kind\":\"turn\"}\n\n");
  } finally {
    hub.close();
  }
});

test("SSE reconnect replays events after the supplied cursor", () => {
  const hub = new SseHub({ heartbeatMs: 60_000 });
  const writes = [];
  const req = { on() {} };
  const res = {
    writeHead() {},
    write(value) { writes.push(value); },
    end() {},
  };
  try {
    hub.broadcast({ kind: "first" });
    hub.broadcast({ kind: "second" });
    hub.connect(req, res, {}, 1);
    assert.equal(writes[0], "id: 2\ndata: {\"kind\":\"second\"}\n\n");
    assert.match(writes[1], /^id: 2\ndata: .*"connected"/);
  } finally {
    hub.close();
  }
});
