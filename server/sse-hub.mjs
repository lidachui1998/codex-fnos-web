export class SseHub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => this.broadcast({ kind: "heartbeat", at: Date.now() }), 20_000);
    this.timer.unref();
  }

  connect(req, res, initialState) {
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ kind: "connected", ...initialState })}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }
}
