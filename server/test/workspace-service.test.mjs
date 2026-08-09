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
  writeFileSync(join(projectPath, "src", "index.js"), "export const ready = true;\n");
  writeFileSync(join(projectPath, "src", "pixel.png"), onePixelPng);
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
    const image = service.read({ path: projectPath }, "src/pixel.png");
    assert.deepEqual({ ...image, dataUrl: image.dataUrl.slice(0, 22) }, {
      path: "src/pixel.png",
      size: onePixelPng.length,
      kind: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,",
    });
    assert.throws(() => service.read({ path: projectPath }, "../outside.txt"), /超出项目目录|ENOENT/);
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
