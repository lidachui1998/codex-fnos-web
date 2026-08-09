import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppearanceService } from "../appearance-service.mjs";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("background status exposes a cache-busting updatedAt value", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-fnos-appearance-"));
  try {
    const appearance = new AppearanceService(root);
    assert.deepEqual(appearance.status(), { hasBackground: false, updatedAt: null });
    const saved = appearance.save(onePixelPng);
    assert.equal(saved.hasBackground, true);
    assert.equal(typeof saved.updatedAt, "number");
    assert.deepEqual(Object.keys(saved).sort(), ["hasBackground", "updatedAt"]);
    assert.deepEqual(appearance.remove(), { hasBackground: false, updatedAt: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
