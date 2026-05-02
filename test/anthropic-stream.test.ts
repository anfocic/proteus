import { test } from "node:test";
import assert from "node:assert/strict";
import { streamFromAnthropicSSE } from "../src/llm/anthropic.ts";
import type { SSERecord } from "../src/llm/sse.ts";
import type { StreamEvent } from "../src/llm/types.ts";

async function* records(...items: SSERecord[]): AsyncGenerator<SSERecord> {
  for (const r of items) yield r;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function rec(event: string, data: unknown): SSERecord {
  return { event, data: JSON.stringify(data) };
}

test("text-only turn → message_start, text_delta×N, message_stop", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        rec("message_start", {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        }),
        rec("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        rec("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
        rec("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
        rec("content_block_stop", { type: "content_block_stop", index: 0 }),
        rec("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
        rec("message_stop", { type: "message_stop" }),
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "msg_1" },
    { type: "text_delta", index: 0, text: "Hello" },
    { type: "text_delta", index: 0, text: " world" },
    {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      content: [{ type: "text", text: "Hello world" }],
    },
  ]);
});

test("text-then-tool turn assembles tool_use input from input_json_delta", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        rec("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5 } } }),
        rec("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        rec("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking" } }),
        rec("content_block_stop", { type: "content_block_stop", index: 0 }),
        rec("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
        }),
        rec("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city"' },
        }),
        rec("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ':"Oslo"}' },
        }),
        rec("content_block_stop", { type: "content_block_stop", index: 1 }),
        rec("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }),
        rec("message_stop", { type: "message_stop" }),
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "msg_2" },
    { type: "text_delta", index: 0, text: "Looking" },
    { type: "tool_use_start", index: 1, id: "tu_1", name: "get_weather" },
    { type: "tool_use_stop", index: 1, input: { city: "Oslo" } },
    {
      type: "message_stop",
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 8 },
      content: [
        { type: "text", text: "Looking" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Oslo" } },
      ],
    },
  ]);
});

test("ping and unknown event types are ignored", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        rec("ping", { type: "ping" }),
        rec("message_start", { type: "message_start", message: { id: "m" } }),
        rec("future_event", { type: "future_event" }),
        rec("message_stop", { type: "message_stop" }),
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "m" },
    {
      type: "message_stop",
      stopReason: "error",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [],
    },
  ]);
});

test("empty tool_use input → {} not _raw", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        rec("message_start", { type: "message_start", message: { id: "m" } }),
        rec("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu", name: "ping" },
        }),
        rec("content_block_stop", { type: "content_block_stop", index: 0 }),
        rec("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        rec("message_stop", { type: "message_stop" }),
      ),
    ),
  );

  const toolStop = events.find((e) => e.type === "tool_use_stop") as Extract<
    StreamEvent,
    { type: "tool_use_stop" }
  >;
  assert.deepEqual(toolStop.input, {});
});

test("malformed input_json_delta → { _raw }", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        rec("message_start", { type: "message_start", message: { id: "m" } }),
        rec("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu", name: "x" },
        }),
        rec("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{not json" },
        }),
        rec("content_block_stop", { type: "content_block_stop", index: 0 }),
        rec("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        rec("message_stop", { type: "message_stop" }),
      ),
    ),
  );

  const toolStop = events.find((e) => e.type === "tool_use_stop") as Extract<
    StreamEvent,
    { type: "tool_use_stop" }
  >;
  assert.deepEqual(toolStop.input, { _raw: "{not json" });
});
