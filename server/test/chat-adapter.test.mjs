import assert from "node:assert/strict";
import test from "node:test";
import { responsesToChat, translateChatResponse } from "../chat-adapter.mjs";

test("converts Responses messages and tools to Chat Completions", () => {
  const result = responsesToChat({
    model: "mock-model",
    instructions: "Be concise",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      { type: "function_call_output", call_id: "call-1", output: "contents" },
    ],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } }],
  }, "fallback");

  assert.deepEqual(result.messages, [
    { role: "system", content: "Be concise" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      }],
    },
    { role: "tool", tool_call_id: "call-1", content: "contents" },
  ]);
  assert.deepEqual(result.tools, [{
    type: "function",
    function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
  }]);
});

test("converts a non-streaming chat response to a Responses object", () => {
  const result = translateChatResponse({
    id: "chat-1",
    created: 123,
    model: "mock-model",
    choices: [{ message: { content: "hello", tool_calls: [] } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }, "fallback");

  assert.equal(result.id, "chat-1");
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].text, "hello");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});
