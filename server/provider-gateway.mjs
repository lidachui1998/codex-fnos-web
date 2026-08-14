import { readJson, sendError, sendJson } from "./lib/http.mjs";
import { isInternalAuthorized } from "./lib/security.mjs";
import { responsesToChat, streamChatAsResponses, translateChatResponse } from "./chat-adapter.mjs";
import { forwardResponses, requestChatCompletions } from "./provider-client.mjs";
import { decodeProviderRoute } from "./provider-routing.mjs";

export async function handleProviderGateway(req, res, stores, token, providerId) {
  if (!isInternalAuthorized(req.headers.authorization, token)) {
    sendError(res, 401, "内部供应商网关认证失败");
    return;
  }
  let provider = stores.getProviderSecret(providerId);
  if (!provider || !provider.enabled) {
    sendError(res, 404, "供应商不存在或已停用");
    return;
  }
  let body = await readJson(req, 10 * 1024 * 1024);
  const routed = decodeProviderRoute(body.model);
  if (routed) {
    provider = stores.getProviderSecret(routed.providerId);
    if (!provider || !provider.enabled) {
      sendError(res, 404, "重试所选供应商不存在或已停用");
      return;
    }
    body = { ...body, model: routed.model };
  }
  const proxy = stores.getEffectiveProxy(provider);

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
