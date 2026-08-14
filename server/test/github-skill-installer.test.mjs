import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubSkillInstaller, parseGitHubSkillSource } from "../github-skill-installer.mjs";

test("GitHub Skill URLs support repositories, tree paths and blob links", () => {
  assert.deepEqual(parseGitHubSkillSource("openai/skills"), {
    owner: "openai", repo: "skills", ref: "main", skillPath: "", repositoryUrl: "https://github.com/openai/skills",
  });
  assert.deepEqual(parseGitHubSkillSource("https://github.com/openai/skills/tree/release/skills/.curated/docs"), {
    owner: "openai", repo: "skills", ref: "release", skillPath: "skills/.curated/docs", repositoryUrl: "https://github.com/openai/skills",
  });
  assert.equal(parseGitHubSkillSource("https://github.com/openai/skills/blob/main/demo/SKILL.md").skillPath, "demo");
  assert.equal(parseGitHubSkillSource("https://github.com/openai/skills/tree/main/demo", "feature/test").ref, "feature/test");
  assert.throws(() => parseGitHubSkillSource("https://example.com/owner/repo"), /github.com/);
});

test("a selected GitHub Skill directory is checked and installed atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-github-skill-"));
  const repository = join(root, "fixture", "repo-main", "skills", "sample-skill");
  const archive = join(root, "repository.tar.gz");
  const codexHome = join(root, "codex-home");
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, "SKILL.md"), "---\nname: sample-skill\n---\n\n# Sample\n");
  writeFileSync(join(repository, "helper.txt"), "safe\n");
  const tar = spawnSync("tar", ["-czf", archive, "-C", join(root, "fixture"), "repo-main"], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const installer = new GitHubSkillInstaller({
    codexHome,
    fetchImpl: async () => ({ ok: true, status: 200, body: createReadStream(archive) }),
  });
  try {
    assert.deepEqual(await installer.install({ url: "https://github.com/example/repo/tree/main/skills/sample-skill" }), {
      name: "sample-skill",
      path: join(codexHome, "skills", "sample-skill").replaceAll("\\", "/"),
      source: "example/repo@main",
      repositoryUrl: "https://github.com/example/repo",
    });
    assert.equal(readFileSync(join(codexHome, "skills", "sample-skill", "SKILL.md"), "utf8"), "---\nname: sample-skill\n---\n\n# Sample\n");
    assert.equal(existsSync(join(codexHome, "skills", "sample-skill", "helper.txt")), true);
    await assert.rejects(() => installer.install({ url: "https://github.com/example/repo/tree/main/skills/sample-skill" }), /已存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
