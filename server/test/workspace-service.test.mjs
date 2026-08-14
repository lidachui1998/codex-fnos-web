import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { WorkspaceService, parseGitStatus } from "../workspace-service.mjs";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("workspace files stay inside the project and text files can be read", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-workspace-"));
  const projectPath = join(root, "project");
  mkdirSync(join(projectPath, "src"), { recursive: true });
  mkdirSync(join(projectPath, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(projectPath, "src", "index.js"), "export const ready = true;\n");
  writeFileSync(join(projectPath, "src", "pixel.png"), onePixelPng);
  writeFileSync(join(projectPath, "node_modules", "ignored", "index.js"), "ignored\n");
  const service = new WorkspaceService();
  try {
    assert.deepEqual(service.list({ path: projectPath }), {
      path: "",
      parent: null,
      truncated: false,
      entries: [{ name: "src", path: "src", type: "directory", size: null }],
    });
    assert.deepEqual(service.read({ path: projectPath }, "src/index.js"), {
      path: "src/index.js",
      size: 27,
      kind: "text",
      mimeType: "text/plain",
      content: "export const ready = true;\n",
    });
    assert.equal(service.read({ path: projectPath }, `${join(projectPath, "src", "index.js")}:12:3`).path, "src/index.js");
    assert.equal(service.read({ path: projectPath }, `${pathToFileURL(join(projectPath, "src", "index.js"))}#L12`).path, "src/index.js");
    assert.deepEqual(service.search({ path: projectPath }, "index", 10), {
      data: [{ name: "index.js", path: "src/index.js", type: "file", size: 27 }],
      truncated: false,
    });
    assert.deepEqual(service.search({ path: projectPath }, "src", 10).data[0], {
      name: "src", path: "src", type: "directory", size: null,
    });
    assert.deepEqual(service.download({ path: projectPath }, "src/index.js:12:3"), {
      path: "src/index.js",
      target: join(projectPath, "src", "index.js"),
      name: "index.js",
      size: 27,
    });
    const image = service.read({ path: projectPath }, "src/pixel.png");
    assert.deepEqual({ ...image, dataUrl: image.dataUrl.slice(0, 22) }, {
      path: "src/pixel.png",
      size: onePixelPng.length,
      kind: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,",
    });
    assert.throws(() => service.read({ path: projectPath }, "../outside.txt"), /超出项目目录|ENOENT/);
    assert.throws(() => service.download({ path: projectPath }, "../outside.txt"), /超出项目目录|ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace artifacts are sorted and expose safe inline view metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-fnos-artifacts-"));
  const projectPath = join(root, "project");
  mkdirSync(join(projectPath, "output"), { recursive: true });
  writeFileSync(join(projectPath, "output", "report.html"), "<!doctype html><title>Report</title>");
  writeFileSync(join(projectPath, "output", "notes.txt"), "not an artifact");
  const service = new WorkspaceService();
  try {
    const artifacts = service.artifacts({ path: projectPath });
    assert.deepEqual(artifacts.data.map(({ modifiedAt: _modifiedAt, ...item }) => item), [{
      name: "report.html",
      path: "output/report.html",
      size: 36,
      kind: "html",
      mimeType: "text/html; charset=utf-8",
    }]);
    assert.equal(artifacts.truncated, false);
    assert.deepEqual(service.view({ path: projectPath }, "output/report.html"), {
      path: "output/report.html",
      target: join(projectPath, "output", "report.html"),
      name: "report.html",
      size: 36,
      kind: "html",
      mimeType: "text/html; charset=utf-8",
    });
    assert.throws(() => service.view({ path: projectPath }, "../outside.html"), /超出项目目录|ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git porcelain records become readable change items", () => {
  assert.deepEqual(parseGitStatus(" M src/app.ts\0?? notes.txt\0R  src/new.ts\0src/old.ts\0"), [
    { path: "src/app.ts", previousPath: undefined, status: " M", kind: "modified", source: "git" },
    { path: "notes.txt", previousPath: undefined, status: "??", kind: "untracked", source: "git" },
    { path: "src/new.ts", previousPath: "src/old.ts", status: "R ", kind: "renamed", source: "git" },
  ]);
});
