import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function inputError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function marketplaceMatches(marketplace, input) {
  const requestedPath = String(input.marketplacePath || "").trim();
  const requestedName = String(input.remoteMarketplaceName || input.marketplaceName || "").trim();
  if (requestedPath && String(marketplace.path || "") !== requestedPath) return false;
  if (requestedName && String(marketplace.name || "") !== requestedName) return false;
  return true;
}

export function resolvePluginInstallId(catalog, input) {
  const requested = String(input.pluginName || "").trim();
  if (!requested) throw inputError("插件名称不能为空");
  const allMarketplaces = Array.isArray(catalog?.marketplaces) ? catalog.marketplaces : [];
  const selectedMarketplaces = allMarketplaces.filter((marketplace) => marketplaceMatches(marketplace, input));
  const hasSelector = Boolean(input.marketplacePath || input.remoteMarketplaceName || input.marketplaceName);
  if (hasSelector && selectedMarketplaces.length === 0) throw inputError("指定的插件市场不存在或尚未加载", 404);
  const marketplaces = selectedMarketplaces.length > 0 ? selectedMarketplaces : allMarketplaces;
  for (const marketplace of marketplaces) {
    const plugin = (marketplace.plugins ?? []).find((item) =>
      item?.name === requested || item?.id === requested || item?.remotePluginId === requested);
    if (!plugin) continue;
    const isRemote = !marketplace.path;
    const pluginId = String(isRemote ? plugin.remotePluginId || "" : plugin.name || plugin.id || "").trim();
    if (!pluginId && isRemote) throw inputError(`插件 ${requested} 缺少 remotePluginId，已停止安装`, 502);
    if (!pluginId) throw inputError(`插件 ${requested} 缺少远程 ID，已停止安装`, 502);
    return {
      pluginId,
      matched: true,
      marketplaceName: marketplace.name || input.remoteMarketplaceName || input.marketplaceName || null,
      marketplacePath: marketplace.path || input.marketplacePath || null,
    };
  }
  return {
    pluginId: requested,
    matched: false,
    marketplaceName: input.remoteMarketplaceName || input.marketplaceName || null,
    marketplacePath: input.marketplacePath || null,
  };
}

export function buildPluginInstallParams(resolved) {
  const pluginName = String(resolved?.pluginId || "").trim();
  if (!pluginName) throw inputError("插件远程 ID 不能为空", 502);
  const marketplacePath = String(resolved?.marketplacePath || "").trim();
  if (marketplacePath) return { marketplacePath, pluginName };
  const remoteMarketplaceName = String(resolved?.marketplaceName || "").trim();
  if (remoteMarketplaceName) return { remoteMarketplaceName, pluginName };
  throw inputError("插件缺少可用的市场来源，已停止安装", 502);
}

export function resolvePluginUninstallId(catalog, requestedId) {
  const requested = String(requestedId || "").trim();
  if (!requested) throw inputError("插件 ID 不能为空");
  for (const marketplace of catalog?.marketplaces ?? []) {
    const plugin = (marketplace.plugins ?? []).find((item) =>
      item?.id === requested
      || item?.name === requested
      || item?.remotePluginId === requested
      || item?.shareContext?.remotePluginId === requested);
    if (!plugin) continue;
    if (marketplace.path) return String(plugin.id || requested).trim();
    const remotePluginId = String(plugin.shareContext?.remotePluginId || plugin.remotePluginId || "").trim();
    if (!remotePluginId) throw inputError(`远程插件 ${plugin.name || requested} 缺少 remotePluginId，已停止卸载`, 502);
    return remotePluginId;
  }
  return requested;
}

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

export function quarantineLegacyPluginCache(codexHome, input, resolvedPluginId, timestamp = Date.now()) {
  const requested = String(input.pluginName || "").trim();
  const marketplace = String(input.remoteMarketplaceName || input.marketplaceName || "").trim();
  if (!requested || !marketplace || requested === resolvedPluginId) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(requested) || !/^[a-zA-Z0-9._-]+$/.test(marketplace)) return null;
  const cacheRoot = resolve(codexHome, "plugins", "cache");
  const candidate = resolve(cacheRoot, marketplace, requested);
  if (!isInside(cacheRoot, candidate) || !existsSync(candidate)) return null;
  const stats = lstatSync(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  const entries = readdirSync(candidate);
  if (entries.length !== 1 || entries[0] !== ".codex-remote-plugin-install.json") return null;
  const markerPath = join(candidate, entries[0]);
  const markerStats = lstatSync(markerPath);
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) return null;
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  const markerRemoteId = String(marker?.remote_plugin_id || "").trim();
  if (!markerRemoteId || markerRemoteId === resolvedPluginId) return null;
  const backup = `${candidate}.invalid-${Math.floor(timestamp / 1000)}`;
  if (existsSync(backup)) return null;
  renameSync(candidate, backup);
  return backup;
}
