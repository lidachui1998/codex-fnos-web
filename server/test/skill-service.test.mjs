import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillService } from "../skill-service.mjs";

test("skills can be listed, previewed and enabled through app-server", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-skills-"));
  const path = join(root, "SKILL.md");
  writeFileSync(path, "# Review\n\nCheck the project.\n");
  const requests = [];
  const skill = { name: "review", description: "Check the project", path, scope: "user", enabled: true };
  const bridge = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === "skills/list") return { data: [{ cwd: root, skills: [skill], errors: [] }] };
      if (method === "skills/config/write") return {};
      throw new Error(`unexpected ${method}`);
    },
  };
  const service = new SkillService(bridge);
  try {
    assert.deepEqual(await service.read({ path: root }, path), {
      skill,
      content: "# Review\n\nCheck the project.\n",
    });
    assert.deepEqual((await service.setEnabled({ path: root }, { path, enabled: false })).skills, [skill]);
    assert.deepEqual(requests.find((item) => item.method === "skills/config/write"), {
      method: "skills/config/write",
      params: { path, name: null, enabled: false },
    });
    await assert.rejects(() => service.read({ path: root }, join(root, "other.md")), /不属于当前项目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
