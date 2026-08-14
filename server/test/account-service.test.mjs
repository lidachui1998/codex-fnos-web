import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { join } from "node:path";
import { AccountService, resolveCodexAccountHome, selectCodexRateLimitSnapshot } from "../account-service.mjs";
import { openDatabase } from "../database.mjs";
import { Stores } from "../stores.mjs";

test("account homes preserve the legacy profile and isolate additional profiles", () => {
  assert.equal(
    resolveCodexAccountHome("/data/codex-home", "/data/codex-accounts", { homeKey: "legacy" }),
    resolve("/data/codex-home"),
  );
  const isolated = resolveCodexAccountHome("/data/codex-home", "/data/codex-accounts", { homeKey: "account-2" });
  assert.match(isolated.replaceAll("\\", "/"), /\/data\/codex-accounts\/account-2\/codex-home$/);
  assert.throws(
    () => resolveCodexAccountHome("/data/codex-home", "/data/codex-accounts", { homeKey: "../escape" }),
    /目录标识无效/,
  );
});

test("Codex usage selects the dedicated codex limit before the account fallback", () => {
  const fallback = { primary: { usedPercent: 0, windowDurationMins: 43_200 } };
  const codex = { primary: { usedPercent: 100, windowDurationMins: 300 } };
  assert.equal(selectCodexRateLimitSnapshot({
    rateLimits: fallback,
    rateLimitsByLimitId: { codex, other: { primary: { usedPercent: 12 } } },
  }), codex);
  assert.equal(selectCodexRateLimitSnapshot({
    rateLimits: { ...fallback, limitId: "codex" },
  }).primary.usedPercent, 0);
  assert.equal(selectCodexRateLimitSnapshot({
    rateLimits: { ...fallback, limitId: "codex_other" },
  }), null);
  assert.equal(selectCodexRateLimitSnapshot({
    rateLimits: fallback,
    rateLimitsByLimitId: { CODEX: codex },
  }), codex);
  assert.equal(selectCodexRateLimitSnapshot({
    rateLimits: fallback,
    rateLimitsByLimitId: { opaque: { ...codex, limitId: "Codex" } },
  }).primary.usedPercent, 100);
});

test("switching accounts restarts app-server with an isolated Codex home and reads usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-accounts-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(join(root, "state.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 4), [workspace]);
  class FakeBridge extends EventEmitter {
    constructor() {
      super();
      this.codexHome = "";
      this.started = 0;
      this.stopped = 0;
    }
    async stop() { this.stopped += 1; }
    setCodexHome(home) { this.codexHome = home; }
    async start() { this.started += 1; }
    async request(method) {
      if (method === "account/read") return { account: { type: "chatgpt", email: "active@example.com", planType: "plus" }, requiresOpenaiAuth: true };
      if (method === "account/rateLimits/read") return {
        rateLimits: { planType: "plus", primary: { usedPercent: 0, resetsAt: 1_900_000_000 } },
        rateLimitsByLimitId: {
          codex: { planType: "plus", primary: { usedPercent: 40, resetsAt: 1_800_000_000 } },
        },
      };
      throw new Error(`unexpected method ${method}`);
    }
  }
  const bridge = new FakeBridge();
  const skillInstaller = { codexHome: "", setCodexHome(home) { this.codexHome = home; } };
  const service = new AccountService({
    stores,
    bridge,
    skillInstaller,
    baseCodexHome: join(root, "legacy-home"),
    accountsRoot: join(root, "account-homes"),
  });
  try {
    const added = await service.create({ label: "备用" });
    assert.equal(added.active, true);
    assert.match(bridge.codexHome.replaceAll("\\", "/"), /\/account-homes\/.+\/codex-home$/);
    assert.equal(skillInstaller.codexHome, bridge.codexHome);
    const account = await service.readActive({ refresh: true });
    assert.deepEqual({
      email: account.account.email,
      planType: account.rateLimits.codexRateLimits.planType,
      usedPercent: account.rateLimits.codexRateLimits.primary.usedPercent,
    }, { email: "active@example.com", planType: "plus", usedPercent: 40 });
    bridge.emit("event", {
      kind: "notification",
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 100, resetsAt: 1_800_000_100 } } },
    });
    const updatedAccount = await service.readActive();
    assert.deepEqual(updatedAccount.rateLimits.codexRateLimits.primary, {
      usedPercent: 100,
      resetsAt: 1_800_000_100,
    });
    bridge.emit("event", {
      kind: "notification",
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex_other", primary: { usedPercent: 9 } } },
    });
    const multiBucketAccount = await service.readActive();
    assert.equal(multiBucketAccount.rateLimits.codexRateLimits.primary.usedPercent, 100);
    assert.equal(multiBucketAccount.rateLimits.rateLimitsByLimitId.codex_other.primary.usedPercent, 9);
    const deleted = await service.delete(added.id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.quarantined, true);
    assert.equal(service.list().some((profile) => profile.id === added.id), false);
    assert.equal(service.active().id, "primary");
    await service.switchTo("primary");
    assert.equal(bridge.codexHome, resolve(join(root, "legacy-home")));
    assert.equal(bridge.started, 2);
    assert.equal(bridge.stopped, 2);
  } finally {
    service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
