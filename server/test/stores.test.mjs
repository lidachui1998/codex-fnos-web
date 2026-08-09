import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { Stores } from "../stores.mjs";

function withStores(run) {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-stores-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "project"), { recursive: true });
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 7), [workspace]);
  try {
    return run({ root, workspace, stores });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("an explicitly selected share can become a workspace root", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-extra-root-"));
  const base = join(root, "base");
  const shared = join(root, "shared");
  mkdirSync(base);
  mkdirSync(shared);
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 7), [base], [shared]);
  try {
    stores.addWorkspaceRoot(shared);
    assert.deepEqual(stores.getSettings().workspaceRoots, [base, realpathSync(shared)]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting the global proxy clears its settings reference", () => {
  withStores(({ stores }) => {
    const proxy = stores.saveProxy({ name: "local", kind: "http", url: "http://127.0.0.1:7890" });
    stores.saveSettings({ defaultProxyId: proxy.id });

    assert.equal(stores.deleteProxy(proxy.id), true);
    assert.deepEqual(stores.getSettings().defaultProxyId, null);
  });
});

test("directory browser stays inside configured workspace roots", () => {
  withStores(({ root, workspace, stores }) => {
    const result = stores.browseDirectories(workspace);
    assert.deepEqual(result, {
      path: realpathSync(workspace),
      parent: null,
      roots: [workspace],
      entries: [{ name: "project", path: realpathSync(join(workspace, "project")) }],
    });
    assert.throws(() => stores.browseDirectories(root), /允许的工作区/);
  });
});

test("removing a project only forgets it and preserves its directory", () => {
  withStores(({ workspace, stores }) => {
    const projectPath = join(workspace, "project");
    const project = stores.saveProject({ name: "keep files", path: projectPath, create: false });
    assert.equal(stores.deleteProject(project.id), true);
    assert.equal(realpathSync(projectPath), realpathSync(join(workspace, "project")));
    assert.deepEqual(stores.listProjects(), []);
  });
});

test("appearance and approval settings are normalized", () => {
  withStores(({ stores }) => {
    stores.saveSettings({ approvalPolicy: "never", theme: "dark", backgroundEnabled: false, backgroundOpacity: 0.85 });
    assert.deepEqual(stores.getSettings(), {
      defaultProxyId: null,
      workspaceRoots: stores.workspaceRoots,
      approvalPolicy: "never",
      theme: "dark",
      backgroundEnabled: false,
      backgroundOpacity: 0.85,
    });
  });
});

test("approval policy is persisted independently for each thread", () => {
  withStores(({ stores }) => {
    stores.saveThreadApprovalPolicy("thread-a", "never");
    stores.saveThreadApprovalPolicy("thread-b", "on-request");
    assert.equal(stores.getThreadApprovalPolicy("thread-a"), "never");
    assert.equal(stores.getThreadApprovalPolicy("thread-b"), "on-request");
    assert.equal(stores.deleteThreadPreferences("thread-a"), true);
    assert.equal(stores.getThreadApprovalPolicy("thread-a"), null);
    assert.equal(stores.getThreadApprovalPolicy("thread-b"), "on-request");
  });
});

test("one proxy profile stores all protocols and providers can force direct mode", () => {
  withStores(({ stores }) => {
    const proxy = stores.saveProxy({
      name: "combined",
      httpUrl: "http://127.0.0.1:8080",
      httpsUrl: "https://127.0.0.1:8443",
      socks5Url: "socks5://127.0.0.1:1080",
    });
    assert.deepEqual({
      httpUrlHint: proxy.httpUrlHint,
      httpsUrlHint: proxy.httpsUrlHint,
      socks5UrlHint: proxy.socks5UrlHint,
    }, {
      httpUrlHint: "http://127.0.0.1:8080",
      httpsUrlHint: "https://127.0.0.1:8443",
      socks5UrlHint: "socks5://127.0.0.1:1080",
    });
    stores.saveSettings({ defaultProxyId: proxy.id });
    const directProvider = stores.saveProvider({
      name: "direct",
      protocol: "responses",
      baseUrl: "https://api.example.com/v1",
      model: "coder",
      proxyMode: "direct",
    });
    const inheritedProvider = stores.saveProvider({
      name: "inherited",
      protocol: "responses",
      baseUrl: "https://api.example.com/v1",
      model: "coder",
      proxyMode: "inherit",
    });
    assert.equal(stores.getEffectiveProxy(stores.getProviderSecret(directProvider.id)), null);
    assert.equal(stores.getEffectiveProxy(stores.getProviderSecret(inheritedProvider.id)).socks5_url, "socks5://127.0.0.1:1080");
  });
});
