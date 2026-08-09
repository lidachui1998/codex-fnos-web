import { timingSafeEqual } from "node:crypto";
import { readJson, sendError, sendJson } from "./lib/http.mjs";
import { responsesToChat, streamChatAsResponses, translateChatResponse } from "./chat-adapter.mjs";
import { forwardResponses, requestChatCompletions } from "./provider-client.mjs";

function authorized(value, expected) {
  const received = Buffer.from(String(value ?? "").replace(/^Bearer\s+/i, ""));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

export async function handleProviderGateway(req, res, stores, token, providerId) {
  if (!authorized(req.headers.authorization, token)) {
    sendError(res, 401, "内部供应商网关认证失败");
    return;
  }
  const provider = stores.getProviderSecret(providerId);
  if (!provider || !provider.enabled) {
    sendError(res, 404, "供应商不存在或已停用");
    return;
  }
  const proxy = stores.getEffectiveProxy(provider);
  const body = await readJson(req, 10 * 1024 * 1024);

  if (provider.protocol === "responses") {
    const upstream = await forwardResponses(provider, proxy, body, req.headers);
    res.writeHead(upstream.status, {
      "cache-control": "no-cache, no-transform",
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "x-accel-buffering": "no",
    });
    upstream.body?.pipe(res);
    return;
  }

  const chatBody = responsesToChat(body, provider.model, provider.reasoning_profile || "auto");
  const upstream = await requestChatCompletions(provider, proxy, chatBody);
  if (!upstream.ok) {
    const details = (await upstream.text()).slice(0, 2000);
    sendError(res, 502, `第三方供应商返回 HTTP ${upstream.status}`, details);
    return;
  }
  if (chatBody.stream) {
    await streamChatAsResponses(upstream, res, chatBody.model);
    return;
  }
  const chat = await upstream.json();
  sendJson(res, 200, translateChatResponse(chat, chatBody.model));
}
