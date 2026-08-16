import assert from "node:assert/strict";
import test from "node:test";

import { subagentStates } from "../../src/subagents.ts";

test("a new main turn does not revive historical subagents", () => {
  const states = subagentStates([
    {
      id: "spawn-old",
      turnId: "turn-old",
      type: "collabToolCall",
      tool: "spawnAgent",
      newThreadId: "agent-old",
      status: "completed",
      agentStatus: "running",
    },
    { id: "user-new", turnId: "turn-new", type: "userMessage" },
  ], "turn-new");

  assert.deepEqual(states, [{ id: "agent-old", status: "completed", message: null }]);
});

test("a subagent spawned by the active turn remains running", () => {
  const states = subagentStates([
    {
      id: "spawn-current",
      turnId: "turn-current",
      type: "collabToolCall",
      tool: "spawnAgent",
      newThreadId: "agent-current",
      status: "completed",
      agentStatus: "running",
    },
  ], "turn-current");

  assert.deepEqual(states, [{ id: "agent-current", status: "running", message: null }]);
});

test("terminal subagent states remain terminal during later turns", () => {
  const states = subagentStates([
    {
      id: "wait-old",
      turnId: "turn-old",
      type: "collabToolCall",
      tool: "wait",
      agentsStates: { "agent-old": { status: "completed", message: "done" } },
    },
    { id: "activity-old", turnId: "turn-old", type: "subAgentActivity", agentThreadId: "agent-old", kind: "message" },
  ], "turn-new");

  assert.deepEqual(states, [{ id: "agent-old", path: undefined, status: "completed", message: "done" }]);
});
