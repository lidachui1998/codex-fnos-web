import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWorkspaceCandidates } from "../workspace-roots.mjs";

test("share discovery exposes one level and hides fnOS system folders", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-volumes-"));
  mkdirSync(join(root, "vol1", "photos"), { recursive: true });
  mkdirSync(join(root, "vol1", "@appshare"), { recursive: true });
  mkdirSync(join(root, "vol1", "photos", "private"), { recursive: true });
  try {
    assert.deepEqual(discoverWorkspaceCandidates(root), [join(root, "vol1", "photos")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
