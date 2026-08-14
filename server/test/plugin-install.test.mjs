import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPluginInstallParams, quarantineLegacyPluginCache, resolvePluginInstallId, resolvePluginUninstallId } from "../plugin-install.mjs";

const catalog = {
  marketplaces: [{
    name: "openai-curated-remote",
    path: null,
    plugins: [{
      name: "github",
      id: "github@openai-curated-remote",
      remotePluginId: "plugins~Plugin_00000000000000000000000000000000",
    }],
  }],
};

test("plugin display names resolve to the remote catalog id", () => {
  const resolved = resolvePluginInstallId(catalog, {
    pluginName: "github",
    marketplaceName: "openai-curated-remote",
  });
  assert.deepEqual(resolved, {
    pluginId: "plugins~Plugin_00000000000000000000000000000000",
    matched: true,
    marketplaceName: "openai-curated-remote",
    marketplacePath: null,
  });
  assert.deepEqual(buildPluginInstallParams(resolved), {
    remoteMarketplaceName: "openai-curated-remote",
    pluginName: "plugins~Plugin_00000000000000000000000000000000",
  });
  assert.equal(resolvePluginInstallId(catalog, { pluginName: "local-plugin" }).pluginId, "local-plugin");
});

test("remote plugin installs use one source selector and the resolved id", () => {
  assert.deepEqual(buildPluginInstallParams({
    pluginId: "plugins~Plugin_00000000000000000000000000000000",
    marketplaceName: "openai-curated-remote",
    marketplacePath: null,
  }), {
    remoteMarketplaceName: "openai-curated-remote",
    pluginName: "plugins~Plugin_00000000000000000000000000000000",
  });
});

test("remote plugin uninstall resolves the backend remote plugin id", () => {
  assert.equal(
    resolvePluginUninstallId(catalog, "github@openai-curated-remote"),
    "plugins~Plugin_00000000000000000000000000000000",
  );
  assert.equal(
    resolvePluginUninstallId(catalog, "plugins~Plugin_00000000000000000000000000000000"),
    "plugins~Plugin_00000000000000000000000000000000",
  );
});

test("invalid short-id plugin cache is quarantined without deleting it", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-plugin-cache-"));
  const candidate = join(home, "plugins", "cache", "openai-curated-remote", "github");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, ".codex-remote-plugin-install.json"), JSON.stringify({ schema_version: 1, remote_plugin_id: "github" }));
  try {
    const backup = quarantineLegacyPluginCache(home, {
      pluginName: "github",
      marketplaceName: "openai-curated-remote",
    }, "plugins~Plugin_00000000000000000000000000000000", 1_700_000_000_000);
    assert.equal(backup, `${candidate}.invalid-1700000000`);
    assert.equal(JSON.parse(readFileSync(join(backup, ".codex-remote-plugin-install.json"), "utf8")).remote_plugin_id, "github");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote plugin installation stops if the catalog omits remotePluginId", () => {
  assert.throws(() => resolvePluginInstallId({
    marketplaces: [{
      name: "openai-curated-remote",
      path: null,
      plugins: [{ name: "github", id: "github@openai-curated-remote", remotePluginId: null }],
    }],
  }, {
    pluginName: "github",
    marketplaceName: "openai-curated-remote",
  }), /remotePluginId/);
});
