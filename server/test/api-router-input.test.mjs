import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnInput, findActiveTurn, readApprovalPolicy, readReasoningEffort, readRetryProvider } from "../api-router.mjs";

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

test("turn input validates and explicitly invokes selected skills", () => {
  const available = [{ name: "project-review", path: "/skills/project-review/SKILL.md", enabled: true }];
  assert.deepEqual(buildTurnInput({
    text: "检查当前项目",
    skills: [{ name: "project-review", path: "/skills/project-review/SKILL.md" }],
  }, available), [
    { type: "text", text: "$project-review\n\n检查当前项目" },
    { type: "skill", name: "project-review", path: "/skills/project-review/SKILL.md" },
  ]);
  assert.throws(() => buildTurnInput({ skills: [{ name: "missing", path: "/tmp/missing" }] }, available), /不可用/);
});

test("approval policy only accepts per-thread app-server values", () => {
  assert.equal(readApprovalPolicy("never"), "never");
  assert.equal(readApprovalPolicy(""), undefined);
  assert.throws(() => readApprovalPolicy("global"), /审批方式无效/);
});

test("retry provider must be an explicitly selected enabled provider", () => {
  const providers = [
    { id: "enabled-api", enabled: true, model: "gpt-api" },
    { id: "disabled-api", enabled: false, model: "gpt-disabled" },
  ];
  assert.deepEqual(readRetryProvider({ providerId: "enabled-api" }, providers), {
    providerId: "enabled-api",
    provider: providers[0],
    model: "gpt-api",
    effort: undefined,
  });
  assert.deepEqual(readRetryProvider({ providerId: null, model: "gpt-official" }, providers), {
    providerId: null,
    provider: null,
    model: "gpt-official",
    effort: undefined,
  });
  assert.throws(() => readRetryProvider({ providerId: "disabled-api" }, providers), /不存在或未启用/);
  assert.throws(() => readRetryProvider({ providerId: "unselected-api" }, providers), /不存在或未启用/);
});

test("resume recovery finds the current in-progress turn", () => {
  const active = { id: "turn-active", status: "inProgress", items: [] };
  assert.equal(findActiveTurn({ turns: [
    { id: "turn-complete", status: "completed", items: [] },
    active,
  ] }), active);
  assert.equal(findActiveTurn({ turns: [{ id: "turn-failed", status: "failed", items: [] }] }), null);
  assert.equal(findActiveTurn(null), null);
});
