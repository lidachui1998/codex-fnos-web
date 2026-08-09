import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnInput, readReasoningEffort } from "../api-router.mjs";

test("turn input carries text files and images into app-server input", () => {
  assert.deepEqual(buildTurnInput({
    text: "请检查附件",
    attachments: [
      { kind: "text", name: "a.ts", content: "export const a = 1;" },
      { kind: "image", name: "dot.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ],
  }), [
    { type: "text", text: "请检查附件" },
    { type: "text", text: "\n\n<fnos_attachment name=\"a.ts\">\nexport const a = 1;\n</fnos_attachment>" },
    { type: "image", url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" },
  ]);
});

test("reasoning effort only accepts app-server effort names", () => {
  assert.equal(readReasoningEffort("HIGH"), "high");
  assert.equal(readReasoningEffort(""), undefined);
  assert.throws(() => readReasoningEffort("very-hard"), /思考强度无效/);
});
