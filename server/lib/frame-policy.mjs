export function frameAncestors(req) {
  const sources = new Set(["'self'"]);
  try {
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const requestHost = new URL(`http://${forwardedHost || req.headers.host || ""}`).hostname;
    if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)$/i.test(requestHost)) return [...sources].join(" ");
    sources.add(`http://${requestHost}:5666`);
    sources.add(`https://${requestHost}:5667`);
    sources.add(`http://${requestHost}:8000`);
    sources.add(`https://${requestHost}:8001`);
    if (req.headers.referer) {
      const parent = new URL(req.headers.referer);
      const sameNas = parent.hostname === requestHost;
      const fnConnectParent = parent.hostname.endsWith(".fnos.net") && requestHost.endsWith(`.${parent.hostname}`);
      if (["http:", "https:"].includes(parent.protocol) && (sameNas || fnConnectParent)) sources.add(parent.origin);
    }
  } catch {
    // Keep the self-only policy when host or referrer data is malformed.
  }
  return [...sources].join(" ");
}
