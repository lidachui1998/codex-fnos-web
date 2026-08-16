import assert from "node:assert/strict";
import test from "node:test";

import { resolveSubagentStates, subagentStates, threadAgentStatus } from "../../src/subagents.ts";

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

test("authoritative child thread status overrides stale collaboration items", () => {
  const states = resolveSubagentStates([{
    id: "spawn-current",
    turnId: "turn-current",
    type: "collabToolCall",
    tool: "spawnAgent",
    newThreadId: "agent-current",
    status: "completed",
    agentStatus: "running",
  }], "turn-current", [{
    id: "agent-current",
    parentThreadId: "root",
    agentNickname: "审查代理",
    agentRole: "review",
    preview: "",
    cwd: "/project",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
  }]);

  assert.deepEqual(states, [{
    id: "agent-current",
    status: "completed",
    message: null,
    name: "审查代理",
    role: "review",
    parentThreadId: "root",
    updatedAt: 2,
    activeFlags: [],
  }]);
});

test("thread active flags expose approval and input waits", () => {
  assert.equal(threadAgentStatus({ status: { type: "active", activeFlags: ["waitingOnApproval"] } }), "waitingApproval");
  assert.equal(threadAgentStatus({ status: { type: "active", activeFlags: ["waitingOnUserInput"] } }), "waitingInput");
  assert.equal(threadAgentStatus({ status: { type: "active", activeFlags: [] } }), "running");
  assert.equal(threadAgentStatus({ status: { type: "notLoaded" } }), "completed");
});

test("descendant list can reveal an agent before its collab item reaches the parent", () => {
  assert.deepEqual(resolveSubagentStates([], "turn-current", [{
    id: "agent-new",
    parentThreadId: "root",
    preview: "",
    cwd: "/project",
    createdAt: 1,
    updatedAt: 3,
    status: { type: "active", activeFlags: [] },
  }]), [{
    id: "agent-new",
    status: "running",
    name: undefined,
    role: undefined,
    parentThreadId: "root",
    updatedAt: 3,
    activeFlags: [],
  }]);
});
