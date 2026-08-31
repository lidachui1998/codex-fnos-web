import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../database.mjs";
import { KnowledgeService } from "../knowledge-service.mjs";
import { Stores } from "../stores.mjs";
import { WorkspaceService } from "../workspace-service.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-knowledge-"));
  const projectPath = join(root, "project");
  mkdirSync(join(projectPath, "docs"), { recursive: true });
  writeFileSync(join(projectPath, "docs", "session.md"), "# 会话\n\n登录状态保存在本地数据库。\n重启应用后会自动恢复。\n");
  writeFileSync(join(projectPath, ".env"), "SECRET=never-index-this\n");
  const db = openDatabase(join(root, "store.sqlite"));
  const stores = new Stores(db, Buffer.alloc(32, 5), [root]);
  const project = stores.saveProject({ name: "Knowledge project", path: projectPath, create: false });
  const workspace = new WorkspaceService();
  const knowledge = new KnowledgeService({ db, workspace });
  return { root, projectPath, db, project, workspace, knowledge };
}

test("knowledge index searches across NAS files and refreshes incrementally", async () => {
  const { root, projectPath, db, project, knowledge } = fixture();
  try {
    const status = await knowledge.configure(project, { directory: "docs", enabled: true });
    assert.equal(status.state, "ready");
    assert.equal(status.fileCount, 1);
    assert.ok(status.chunkCount >= 1);
    const first = await knowledge.search(project, "登录状态");
    assert.equal(first.data[0].path, "docs/session.md");
    assert.match(first.data[0].citation, /^docs\/session\.md:\d+-\d+$/);

    writeFileSync(join(projectPath, "docs", "session.md"), "# 会话\n\n刷新令牌使用单飞锁，避免并发请求重复续期。\n");
    await knowledge.refresh(project);
    const changed = await knowledge.search(project, "刷新令牌 单飞锁");
    assert.equal(changed.data[0].path, "docs/session.md");
    assert.match(changed.data[0].snippet, /单飞锁/);

    unlinkSync(join(projectPath, "docs", "session.md"));
    const removed = await knowledge.refresh(project);
    assert.equal(removed.fileCount, 0);
    assert.deepEqual((await knowledge.search(project, "刷新令牌")).data, []);
  } finally {
    knowledge.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("editable canvas records versions, compares content, and rolls back", () => {
  const { root, projectPath, db, project, workspace, knowledge } = fixture();
  const reportPath = join(projectPath, "report.md");
  writeFileSync(reportPath, "# 报告\n\n初始内容\n");
  try {
    knowledge.observeFile(project, "report.md", workspace.read(project, "report.md").content);
    const saved = knowledge.saveFile(project, "report.md", "# 报告\n\n画布修改后的内容\n");
    assert.match(saved.content, /画布修改/);
    const versions = knowledge.versions(project, "report.md");
    assert.equal(versions.length, 2);
    assert.equal(versions[0].source, "canvas");
    const original = versions.find((version) => version.source === "observed");
    assert.ok(original);
    assert.match(knowledge.version(project, "report.md", original.id).content, /初始内容/);
    const rolledBack = knowledge.rollback(project, "report.md", original.id);
    assert.equal(rolledBack.restoredVersionId, original.id);
    assert.match(readFileSync(reportPath, "utf8"), /初始内容/);
    assert.equal(knowledge.versions(project, "report.md")[0].source, "rollback");
  } finally {
    knowledge.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
