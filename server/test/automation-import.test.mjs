import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopAutomationToml, prepareDesktopAutomationImport, scheduleFromRRule } from "../automation-import.mjs";

const desktopToml = String.raw`version = 1
id = "daily-github-hot-project-video"
name = "Daily Developer Hot Topic Video"
prompt = "Run powershell -ExecutionPolicy Bypass -File scripts/render-with-voiceover.ps1"
status = "active"
rrule = "RRULE:FREQ=WEEKLY;BYHOUR=19;BYMINUTE=50;BYDAY=SU,MO,TU,WE,TH,FR,SA"
model = "gpt-5.6-terra"
reasoning_effort = "xhigh"
cwds = ["E:\\codex_chat\\github-daily-hot-video"]`;

test("parses a desktop Codex automation and maps an all-week RRULE to daily", () => {
  const parsed = parseDesktopAutomationToml(desktopToml);
  assert.equal(parsed.id, "daily-github-hot-project-video");
  assert.deepEqual(parsed.cwds, ["E:\\codex_chat\\github-daily-hot-video"]);
  assert.deepEqual(scheduleFromRRule(parsed.rrule), { type: "daily", time: "19:50" });
});

test("builds a loss-preserving fnOS import and pauses Windows-only workflows", () => {
  const result = prepareDesktopAutomationImport({ automationToml: desktopToml, memory: "# retained memory" }, { id: "project-1", path: "/vol2/1000/project_fn/hot_news" });
  assert.equal(result.task.enabled, false);
  assert.equal(result.task.model, "gpt-5.6-terra");
  assert.equal(result.task.reasoningEffort, "xhigh");
  assert.equal(result.task.memory, "# retained memory");
  assert.match(result.task.prompt, /fnOS NAS（Linux）/);
  assert.deepEqual(result.preview.issues.map((issue) => issue.code), ["windows-cwd", "powershell"]);
});

test("rejects unsupported monthly recurrence instead of silently changing it", () => {
  assert.throws(() => scheduleFromRRule("RRULE:FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0;BYMONTHDAY=1"), /暂不支持/);
});
