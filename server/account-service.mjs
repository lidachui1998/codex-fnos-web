import { existsSync, mkdirSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const rateLimitCacheMs = 60_000;

function isInside(root, target) {
  const rest = relative(root, target);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

export function resolveCodexAccountHome(baseCodexHome, accountsRoot, profile) {
  if (!profile?.homeKey) throw new Error("Codex 账户目录标识缺失");
  if (profile.homeKey === "legacy") return resolve(baseCodexHome);
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(profile.homeKey)) throw new Error("Codex 账户目录标识无效");
  const root = resolve(accountsRoot);
  const home = resolve(root, profile.homeKey, "codex-home");
  if (!isInside(root, home)) throw new Error("Codex 账户目录越界");
  return home;
}

export function selectCodexRateLimitSnapshot(rateLimits) {
  const buckets = Object.entries(rateLimits?.rateLimitsByLimitId || {});
  const keyed = buckets.find(([limitId]) => limitId.toLowerCase() === "codex")?.[1];
  if (keyed) return keyed;
  const identified = buckets.find(([, snapshot]) => snapshot?.limitId?.toLowerCase() === "codex")?.[1];
  if (identified) return identified;
  return rateLimits?.rateLimits?.limitId?.toLowerCase() === "codex" ? rateLimits.rateLimits : null;
}

export class AccountService {
  constructor({ stores, bridge, skillInstaller, baseCodexHome, accountsRoot }) {
    this.stores = stores;
    this.bridge = bridge;
    this.skillInstaller = skillInstaller;
    this.baseCodexHome = resolve(baseCodexHome);
    this.accountsRoot = resolve(accountsRoot);
    this.rateLimits = new Map();
    this.switchPromise = Promise.resolve();
    mkdirSync(this.accountsRoot, { recursive: true, mode: 0o700 });
    this.eventHandler = (event) => {
      if (event.kind !== "notification" || event.method !== "account/rateLimits/updated") return;
      const active = this.stores.getActiveCodexAccount();
      const current = this.rateLimits.get(active.id)?.value;
      if (!event.params?.rateLimits) return;
      const updated = event.params.rateLimits;
      const limitId = updated.limitId || "codex";
      this.rateLimits.set(active.id, {
        at: Date.now(),
        value: current
          ? {
              ...current,
              rateLimits: current.rateLimits?.limitId === limitId
                ? { ...current.rateLimits, ...updated }
                : current.rateLimits,
              rateLimitsByLimitId: {
                ...(current.rateLimitsByLimitId || {}),
                [limitId]: { ...(current.rateLimitsByLimitId?.[limitId] || {}), ...updated },
              },
            }
          : { rateLimits: updated, rateLimitsByLimitId: { [limitId]: updated }, rateLimitResetCredits: null },
      });
    };
    this.bridge.on("event", this.eventHandler);
  }

  close() {
    this.bridge.off("event", this.eventHandler);
  }

  homeFor(profile) {
    return resolveCodexAccountHome(this.baseCodexHome, this.accountsRoot, profile);
  }

  list() {
    return this.stores.listCodexAccounts();
  }

  active() {
    return this.stores.getActiveCodexAccount();
  }

  async readActive({ refresh = false } = {}) {
    const profile = this.active();
    const account = await this.bridge.request("account/read", { refreshToken: false }, { timeoutMs: 15_000 });
    if (account?.account) this.stores.updateCodexAccountMetadata(profile.id, account.account);
    else this.stores.clearCodexAccountMetadata(profile.id);
    let rateLimits = null;
    let rateLimitsError = null;
    if (account?.account?.type === "chatgpt") {
      const cached = this.rateLimits.get(profile.id);
      if (!refresh && cached && Date.now() - cached.at < rateLimitCacheMs) {
        rateLimits = cached.value;
      } else {
        try {
          rateLimits = await this.bridge.request("account/rateLimits/read", undefined, { timeoutMs: 20_000 });
          this.rateLimits.set(profile.id, { at: Date.now(), value: rateLimits });
        } catch (error) {
          rateLimitsError = error.message || "账户用量读取失败";
          rateLimits = cached?.value ?? null;
        }
      }
    } else {
      this.rateLimits.delete(profile.id);
    }
    return {
      ...account,
      activeProfile: this.active(),
      rateLimits: rateLimits
        ? { ...rateLimits, codexRateLimits: selectCodexRateLimitSnapshot(rateLimits) }
        : null,
      rateLimitsError,
    };
  }

  create(input = {}) {
    const previous = this.active();
    const created = this.stores.createCodexAccount(input);
    return this.#queueSwitch(previous, created);
  }

  switchTo(id) {
    const previous = this.active();
    if (previous.id === String(id)) return Promise.resolve(previous);
    const target = this.stores.listCodexAccounts().find((item) => item.id === String(id));
    if (!target) throw Object.assign(new Error("Codex 账户不存在"), { status: 404 });
    return this.#queueSwitch(previous, target);
  }

  async delete(id) {
    const target = this.stores.listCodexAccounts().find((item) => item.id === String(id));
    if (!target) throw Object.assign(new Error("Codex 账户不存在"), { status: 404 });
    if (target.homeKey === "legacy") {
      throw Object.assign(new Error("主账户槽位承载工作台原始凭据，不能删除；可以先退出登录或改用其他账户"), { status: 400 });
    }
    const remaining = this.stores.listCodexAccounts().filter((item) => item.id !== target.id);
    if (remaining.length === 0) throw Object.assign(new Error("至少需要保留一个 Codex 账户槽位"), { status: 400 });
    if (target.active) await this.#queueSwitch(target, remaining[0]);

    const accountRoot = resolve(this.accountsRoot, target.homeKey);
    let quarantinedPath = null;
    if (existsSync(accountRoot)) {
      const trashRoot = resolve(this.accountsRoot, "deleted-accounts");
      mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
      quarantinedPath = resolve(trashRoot, `${target.homeKey}-${Math.floor(Date.now() / 1000)}`);
      renameSync(accountRoot, quarantinedPath);
    }
    this.rateLimits.delete(target.id);
    this.stores.deleteCodexAccount(target.id);
    return { deleted: true, activeProfile: this.active(), quarantined: Boolean(quarantinedPath) };
  }

  async logout() {
    const profile = this.active();
    const result = await this.bridge.request("account/logout", {});
    this.rateLimits.delete(profile.id);
    this.stores.clearCodexAccountMetadata(profile.id);
    return result;
  }

  #queueSwitch(previous, target) {
    const run = async () => {
      try {
        await this.#activate(target);
        return this.active();
      } catch (error) {
        try {
          await this.#activate(previous);
        } catch {
          // Preserve the original switch error; the bridge state exposes any rollback failure.
        }
        throw error;
      }
    };
    this.switchPromise = this.switchPromise.then(run, run);
    return this.switchPromise;
  }

  async #activate(profile) {
    const active = this.stores.activateCodexAccount(profile.id);
    const home = this.homeFor(active);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    await this.bridge.stop();
    this.bridge.setCodexHome(home);
    this.skillInstaller.setCodexHome(home);
    await this.bridge.start();
    this.rateLimits.delete(active.id);
  }
}
