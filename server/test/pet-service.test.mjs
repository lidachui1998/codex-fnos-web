import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PetService, readWebpDimensions } from "../pet-service.mjs";

function vp8x(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function dataUrl(width, height) {
  return `data:image/webp;base64,${vp8x(width, height).toString("base64")}`;
}

test("imports v1 and v2 Codex pets and persists account-level selection", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-pets-"));
  try {
    const service = new PetService({ codexHome: home });
    const first = service.import({
      manifest: { id: "niannian", displayName: "念念", spritesheetPath: "spritesheet.webp" },
      spritesheetDataUrl: dataUrl(1536, 1872),
    });
    assert.equal(first.pet.spriteVersionNumber, 1);
    assert.deepEqual(first.status.settings, { activePetId: "niannian", visible: true, motion: "full", scale: 1 });

    const second = service.import({
      manifest: { id: "wife-pet-v3", displayName: "Laopo", spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp" },
      spritesheetDataUrl: dataUrl(1536, 2288),
    });
    assert.deepEqual(second.status.pets.map((pet) => [pet.id, pet.spriteVersionNumber]), [["niannian", 1], ["wife-pet-v3", 2]]);

    const updated = service.updateSettings({ activePetId: "wife-pet-v3", motion: "reduced", scale: 1.25, visible: false });
    assert.deepEqual(updated.settings, { activePetId: "wife-pet-v3", visible: false, motion: "reduced", scale: 1.25 });
    assert.deepEqual(new PetService({ codexHome: home }).status().settings, updated.settings);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects unsafe or structurally incompatible pet packages", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-pets-invalid-"));
  try {
    const service = new PetService({ codexHome: home });
    assert.throws(() => service.import({
      manifest: { id: "../escape" },
      spritesheetDataUrl: dataUrl(1536, 1872),
    }), /宠物 ID/);
    assert.throws(() => service.import({
      manifest: { id: "wrong-size" },
      spritesheetDataUrl: dataUrl(100, 100),
    }), /1536×1872/);
    assert.throws(() => service.import({
      manifest: { id: "version-mismatch", spriteVersionNumber: 2 },
      spritesheetDataUrl: dataUrl(1536, 1872),
    }), /1536×2288/);
    assert.throws(() => service.import({
      manifest: { id: "outside", spritesheetPath: "../secret.webp" },
      spritesheetDataUrl: dataUrl(1536, 1872),
    }), /留在宠物目录/);
    assert.throws(() => service.import({
      manifest: { id: "windows-outside", spritesheetPath: "C:/Users/test/secret.webp" },
      spritesheetDataUrl: dataUrl(1536, 1872),
    }), /留在宠物目录/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deletion moves a pet to a recoverable quarantine", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-fnos-pets-delete-"));
  try {
    const service = new PetService({ codexHome: home });
    service.import({ manifest: { id: "safe-pet" }, spritesheetDataUrl: dataUrl(1536, 1872) });
    const removed = service.delete("safe-pet");
    assert.equal(removed.deleted, true);
    assert.equal(removed.recoverable, true);
    assert.equal(removed.status.pets.length, 0);
    assert.equal(removed.status.settings.activePetId, null);
    assert.equal(existsSync(removed.quarantinePath), true);
    assert.equal(JSON.parse(readFileSync(join(removed.quarantinePath, "pet.json"), "utf8")).id, "safe-pet");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reads the dimensions of a bounded VP8X container", () => {
  assert.deepEqual(readWebpDimensions(vp8x(1536, 2288)), { width: 1536, height: 2288 });
  assert.throws(() => readWebpDimensions(Buffer.from("not-webp")), /WebP/);
});
