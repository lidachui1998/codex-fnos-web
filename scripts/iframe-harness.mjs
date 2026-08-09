import { createServer } from "node:http";

const port = Number(process.env.IFRAME_PORT || 5666);
const target = process.env.IFRAME_TARGET || "http://127.0.0.1:19090/";
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fnOS iframe 验收</title><style>*{box-sizing:border-box}html,body,iframe{width:100%;height:100%;margin:0;border:0}body{background:#ddd}</style></head><body><iframe title="Codex 飞牛工作台" src="${target}"></iframe></body></html>`;

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}).listen(port, "127.0.0.1", () => console.log(`fnOS iframe harness listening on http://127.0.0.1:${port}`));
