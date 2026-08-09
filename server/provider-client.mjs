import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";

function shouldBypass(url, noProxy) {
  const host = new URL(url).hostname.toLowerCase();
  return String(noProxy ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((item) => {
      const token = item.split(":")[0].replace(/^\*\.?/, "");
      return token === "*" || host === token || host.endsWith(`.${token}`);
    });
}

export function proxyUrlForTarget(proxy, target) {
  if (!proxy || !proxy.enabled) return "";
  const protocol = new URL(target).protocol;
  if (protocol === "https:") return proxy.https_url || proxy.http_url || proxy.socks5_url || proxy.url || "";
  if (protocol === "http:") return proxy.http_url || proxy.https_url || proxy.socks5_url || proxy.url || "";
  return proxy.socks5_url || proxy.https_url || proxy.http_url || proxy.url || "";
}

export function createProviderAgent(proxy) {
  if (!proxy || !proxy.enabled || !proxyUrlForTarget(proxy, "https://example.com")) return undefined;
  return new ProxyAgent({
    getProxyForUrl: (url) => shouldBypass(url, proxy.no_proxy) ? "" : proxyUrlForTarget(proxy, url),
  });
}

export function endpoint(baseUrl, resource) {
  return `${baseUrl.replace(/\/$/, "")}/${resource.replace(/^\//, "")}`;
}

export function providerHeaders(provider, gatewayHeaders = {}) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...provider.headers,
    ...gatewayHeaders,
  };
  delete headers.host;
  delete headers["content-length"];
  delete headers.authorization;
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

export async function testProxy(proxy, target = "https://api.openai.com/v1/models") {
  const startedAt = performance.now();
  const response = await fetch(target, {
    agent: createProviderAgent(proxy),
    headers: { "user-agent": "codex-fnos-web/0.5.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  response.body?.destroy();
  return {
    ok: true,
    status: response.status,
    latencyMs: Math.round(performance.now() - startedAt),
    message: `代理链路已建立，目标返回 HTTP ${response.status}`,
  };
}

export async function testProvider(provider, proxy) {
  const startedAt = performance.now();
  const url = endpoint(
    provider.base_url,
    provider.protocol === "responses" ? "responses" : "chat/completions",
  );
  const body = provider.protocol === "responses"
    ? {
        model: provider.model,
        input: "Reply with OK only.",
        max_output_tokens: 16,
        stream: false,
      }
    : {
        model: provider.model,
        messages: [{ role: "user", content: "Reply with OK only." }],
        max_tokens: 16,
        stream: false,
      };
  const response = await fetch(url, {
    agent: createProviderAgent(proxy),
    body: JSON.stringify(body),
    headers: providerHeaders(provider),
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`供应商返回 HTTP ${response.status}`);
    error.status = 502;
    error.details = text.slice(0, 800);
    throw error;
  }
  return {
    ok: true,
    status: response.status,
    latencyMs: Math.round(performance.now() - startedAt),
    model: provider.model,
    protocol: provider.protocol,
  };
}

export function parseProviderModels(body) {
  const source = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : Array.isArray(body?.data?.models)
          ? body.data.models
          : Array.isArray(body?.result?.data)
            ? body.result.data
            : [];
  return [...new Set(source.map((item) => String(
    typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model ?? "",
  ).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export async function listProviderModels(provider, proxy) {
  const headers = providerHeaders(provider);
  delete headers["content-type"];
  const response = await fetch(endpoint(provider.base_url, "models"), {
    agent: createProviderAgent(proxy),
    headers,
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`模型列表返回 HTTP ${response.status}`);
    error.status = 502;
    error.details = JSON.stringify(body).slice(0, 800);
    throw error;
  }
  const models = parseProviderModels(body);
  if (models.length === 0) {
    const error = new Error("供应商的 /models 接口没有返回可识别的模型列表");
    error.status = 502;
    error.details = JSON.stringify(body).slice(0, 800);
    throw error;
  }
  return models;
}

export async function forwardResponses(provider, proxy, requestBody, requestHeaders) {
  return fetch(endpoint(provider.base_url, "responses"), {
    agent: createProviderAgent(proxy),
    body: JSON.stringify({ ...requestBody, model: requestBody.model || provider.model }),
    headers: providerHeaders(provider, {
      accept: requestHeaders.accept ?? "text/event-stream",
    }),
    method: "POST",
    signal: AbortSignal.timeout(10 * 60_000),
  });
}

export async function requestChatCompletions(provider, proxy, requestBody) {
  return fetch(endpoint(provider.base_url, "chat/completions"), {
    agent: createProviderAgent(proxy),
    body: JSON.stringify(requestBody),
    headers: providerHeaders(provider),
    method: "POST",
    signal: AbortSignal.timeout(10 * 60_000),
  });
}
