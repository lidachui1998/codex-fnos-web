import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GlobalExtensionService } from "../global-extension-service.mjs";

function storedZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const content = Buffer.from(value);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    local.push(localHeader, filename, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, filename);
    offset += localHeader.length + filename.length + content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

test("creates account-global skills and skills-only plugins", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-extensions-"));
  const service = new GlobalExtensionService({ codexHome: home });
  try {
    const skill = service.createSkill({
      name: "daily-review",
      description: "Review a project at the end of the day",
      instructions: "Inspect changes and produce a concise review.",
    });
    assert.equal(skill.scope, "global");
    assert.match(readFileSync(join(home, "skills", "daily-review", "SKILL.md"), "utf8"), /name: daily-review/);

    const plugin = service.createPlugin({
      name: "release-helper",
      displayName: "Release Helper",
      description: "Prepare release notes",
      instructions: "Summarize user-visible changes.",
    });
    assert.equal(plugin.marketplaceName, "fnos-personal");
    assert.equal(plugin.installed, false);
    assert.equal(existsSync(join(home, ".agents", "plugins", "packages", "release-helper", ".codex-plugin", "plugin.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".agents", "plugins", "marketplace.json"), "utf8")).plugins, [{
      name: "release-helper",
      source: { source: "local", path: "./packages/release-helper" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      interface: { displayName: "Release Helper", shortDescription: "Prepare release notes" },
    }]);
    assert.throws(() => service.createSkill({ name: "daily-review", description: "Duplicate", instructions: "No" }), /已存在/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("imports one Skill or plugin from a bounded ZIP", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-imports-"));
  const service = new GlobalExtensionService({ codexHome: home });
  try {
    const skill = service.importSkill(storedZip({
      "skill-pack/SKILL.md": "---\nname: zip-skill\ndescription: Imported from ZIP\n---\n\nFollow the workflow.\n",
      "skill-pack/references/help.md": "Reference",
    }), "zip-skill.zip");
    assert.equal(skill.name, "zip-skill");
    assert.equal(readFileSync(join(home, "skills", "zip-skill", "references", "help.md"), "utf8"), "Reference");

    const plugin = service.importPlugin(storedZip({
      "plugin-pack/.codex-plugin/plugin.json": JSON.stringify({ name: "zip-plugin", version: "1.2.0", description: "Imported plugin", skills: "./skills/" }),
      "plugin-pack/skills/helper/SKILL.md": "---\nname: helper\ndescription: Help with imports\n---\n\nHelp.\n",
    }), "zip-plugin.zip");
    assert.deepEqual({ name: plugin.name, version: plugin.version, marketplaceName: plugin.marketplaceName }, {
      name: "zip-plugin",
      version: "1.2.0",
      marketplaceName: "fnos-personal",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects ZIP traversal and ambiguous Skill bundles", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-import-safety-"));
  const service = new GlobalExtensionService({ codexHome: home });
  try {
    assert.throws(() => service.importSkill(storedZip({
      "../escape/SKILL.md": "---\nname: escape\ndescription: Escape\n---\n",
    }), "escape.zip"), /不安全路径/);
    assert.throws(() => service.importSkill(storedZip({
      "one/SKILL.md": "---\nname: one\ndescription: One\n---\n",
      "two/SKILL.md": "---\nname: two\ndescription: Two\n---\n",
    }), "many.zip"), /多个 Skills/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
