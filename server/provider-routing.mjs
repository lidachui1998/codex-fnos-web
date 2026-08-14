const prefix = "fnos-provider-route-v1:";
const providerIdPattern = /^[a-zA-Z0-9._-]{1,160}$/;

export function encodeProviderRoute(providerId, model) {
  const id = String(providerId || "").trim();
  const modelId = String(model || "").trim();
  if (!providerIdPattern.test(id)) throw new Error("路由供应商 ID 无效");
  if (!modelId || modelId.length > 500) throw new Error("路由模型 ID 无效");
  return `${prefix}${Buffer.from(JSON.stringify({ providerId: id, model: modelId }), "utf8").toString("base64url")}`;
}

export function decodeProviderRoute(value) {
  const model = String(value || "");
  if (!model.startsWith(prefix)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(model.slice(prefix.length), "base64url").toString("utf8"));
    const providerId = String(decoded?.providerId || "").trim();
    const modelId = String(decoded?.model || "").trim();
    if (!providerIdPattern.test(providerId) || !modelId || modelId.length > 500) return null;
    return { providerId, model: modelId };
  } catch {
    return null;
  }
}
