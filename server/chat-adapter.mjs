import { randomUUID } from "node:crypto";

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type))
    .map((part) => part.text ?? "")
    .join("");
}

export function responsesToChat(body, fallbackModel) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  for (const item of input) {
    if (item.type === "message") {
      messages.push({ role: item.role ?? "user", content: textContent(item.content) });
      continue;
    }
    if (item.type === "function_call") {
      const previous = messages.at(-1);
      const target = previous?.role === "assistant" && Array.isArray(previous.tool_calls)
        ? previous
        : { role: "assistant", content: null, tool_calls: [] };
      if (target !== previous) messages.push(target);
      target.tool_calls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "" },
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
    }
  }

  return {
    model: body.model || fallbackModel,
    messages,
    tools: Array.isArray(body.tools)
      ? body.tools.filter((tool) => tool.type === "function").map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? {},
          },
        }))
      : undefined,
    tool_choice: body.tool_choice === "none" ? "none" : body.tool_choice === "required" ? "required" : "auto",
    stream: body.stream !== false,
    stream_options: body.stream === false ? undefined : { include_usage: true },
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
  };
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function messageItem(id, text, status = "in_progress") {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function translateChatResponse(chat, model) {
  const choice = chat.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  if (message.content) output.push(messageItem(`msg_${randomUUID()}`, message.content, "completed"));
  for (const call of message.tool_calls ?? []) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function?.name ?? "tool",
      arguments: call.function?.arguments ?? "{}",
    });
  }
  return {
    id: chat.id ?? `resp_${randomUUID()}`,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chat.model ?? model,
    output,
    usage: chat.usage ? {
      input_tokens: chat.usage.prompt_tokens ?? 0,
      output_tokens: chat.usage.completion_tokens ?? 0,
      total_tokens: chat.usage.total_tokens ?? 0,
    } : null,
  };
}

export async function streamChatAsResponses(upstream, res, model) {
  const responseId = `resp_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const messageId = `msg_${randomUUID()}`;
  const toolStates = new Map();
  let messageStarted = false;
  let messageText = "";
  let usage = null;

  res.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  sse(res, {
    type: "response.created",
    response: { id: responseId, object: "response", created_at: createdAt, status: "in_progress", model, output: [] },
  });

  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (!payload || payload === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta ?? {};
      if (delta.content) {
        if (!messageStarted) {
          messageStarted = true;
          sse(res, { type: "response.output_item.added", output_index: 0, item: messageItem(messageId, "") });
          sse(res, {
            type: "response.content_part.added",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        messageText += delta.content;
        sse(res, {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }
      for (const toolDelta of delta.tool_calls ?? []) {
        const index = Number(toolDelta.index ?? 0);
        let state = toolStates.get(index);
        if (!state) {
          state = {
            id: `fc_${randomUUID()}`,
            callId: toolDelta.id ?? `call_${randomUUID()}`,
            name: "",
            arguments: "",
            outputIndex: (messageStarted ? 1 : 0) + toolStates.size,
          };
          toolStates.set(index, state);
          sse(res, {
            type: "response.output_item.added",
            output_index: state.outputIndex,
            item: {
              id: state.id,
              type: "function_call",
              status: "in_progress",
              call_id: state.callId,
              name: state.name,
              arguments: "",
            },
          });
        }
        if (toolDelta.function?.name) state.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) {
          state.arguments += toolDelta.function.arguments;
          sse(res, {
            type: "response.function_call_arguments.delta",
            item_id: state.id,
            output_index: state.outputIndex,
            delta: toolDelta.function.arguments,
          });
        }
      }
    }
  }

  const output = [];
  if (messageStarted) {
    const item = messageItem(messageId, messageText, "completed");
    output.push(item);
    sse(res, { type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text: messageText });
    sse(res, { type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: item.content[0] });
    sse(res, { type: "response.output_item.done", output_index: 0, item });
  }
  for (const state of toolStates.values()) {
    const item = {
      id: state.id,
      type: "function_call",
      status: "completed",
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
    };
    output.push(item);
    sse(res, { type: "response.function_call_arguments.done", item_id: state.id, output_index: state.outputIndex, arguments: state.arguments });
    sse(res, { type: "response.output_item.done", output_index: state.outputIndex, item });
  }
  const response = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model,
    output,
    usage: usage ? {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    } : null,
  };
  sse(res, { type: "response.completed", response });
  res.end();
}
