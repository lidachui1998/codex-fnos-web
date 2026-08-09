import assert from "node:assert/strict";
import test from "node:test";
import { baseVersion, compareVersions } from "../codex-updater.mjs";

test("Codex platform versions compare by their release version", () => {
  assert.equal(baseVersion("0.147.0-linux-x64"), "0.147.0");
  assert.equal(compareVersions("0.148.0", "0.147.9"), 1);
  assert.equal(compareVersions("0.147.0-linux-x64", "0.147.0"), 0);
  assert.equal(compareVersions("0.146.9", "0.147.0"), -1);
});
