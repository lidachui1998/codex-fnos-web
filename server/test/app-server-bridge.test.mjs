import assert from "node:assert/strict";
import test from "node:test";
import { codexRuntimeConfig, preserveUnmanagedConfig } from "../app-server-bridge.mjs";

test("enables subagents and long-lived unified exec for every new thread", () => {
  assert.deepEqual(codexRuntimeConfig("xhigh"), {
    "agents.enabled": true,
    "agents.max_concurrent_threads_per_session": 4,
    experimental_use_unified_exec_tool: true,
    background_terminal_max_timeout: 3_600_000,
    model_reasoning_effort: "xhigh",
  });
});

test("preserves plugin and user config while removing legacy managed values", () => {
  const source = `model_provider = "old"
approval_policy = "never"
experimental_use_unified_exec_tool = false
background_terminal_max_timeout = 300000

[features]
plugins = true

[model_providers.fnos-old]
name = "old"
base_url = "http://old"

[plugins.example]
enabled = true
`;
  assert.equal(preserveUnmanagedConfig(source), `[features]
plugins = true

[plugins.example]
enabled = true`);
});

test("removes a previous managed block without touching surrounding config", () => {
  const source = `notify = ["echo"]

# BEGIN CODEX FNOS WEB MANAGED
model_provider = "openai"
[model_providers.fnos-provider]
name = "provider"
# END CODEX FNOS WEB MANAGED

[features]
plugins = true
`;
  assert.equal(preserveUnmanagedConfig(source), `notify = ["echo"]


[features]
plugins = true`);
});
