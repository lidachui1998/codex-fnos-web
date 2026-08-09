import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listProviderModels, parseProviderModels, proxyUrlForTarget } from "../provider-client.mjs";

test("normalizes common supplier model-list response shapes", () => {
  assert.deepEqual(parseProviderModels({ data: [{ id: "model-b" }, { id: "model-a" }] }), ["model-a", "model-b"]);
  assert.deepEqual(parseProviderModels({ models: [{ name: "alpha" }, "beta"] }), ["alpha", "beta"]);
  assert.deepEqual(parseProviderModels({ data: { models: [{ model: "nested" }] } }), ["nested"]);
  assert.deepEqual(parseProviderModels({ result: { data: [{ id: "result-model" }] } }), ["result-model"]);
});

test("requests Base URL plus /models with the configured API key", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["content-type"], undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "coder-fast" }, { id: "coder" }] }));
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  try {
    const models = await listProviderModels({
      base_url: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      headers: {},
    }, null);
    assert.deepEqual(models, ["coder", "coder-fast"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("selects HTTP, HTTPS and SOCKS5 URLs from one proxy profile", () => {
  const proxy = {
    enabled: 1,
    http_url: "http://proxy.local:8080",
    https_url: "https://secure-proxy.local:8443",
    socks5_url: "socks5://socks.local:1080",
  };
  assert.equal(proxyUrlForTarget(proxy, "http://example.com"), proxy.http_url);
  assert.equal(proxyUrlForTarget(proxy, "https://example.com"), proxy.https_url);
  assert.equal(proxyUrlForTarget({ ...proxy, https_url: "" }, "https://example.com"), proxy.http_url);
  assert.equal(proxyUrlForTarget({ ...proxy, http_url: "", https_url: "" }, "https://example.com"), proxy.socks5_url);
});
