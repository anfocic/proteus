import { test } from "node:test";
import assert from "node:assert/strict";
import { streamFromOpenAISSE } from "../src/llm/openai-compat.ts";
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

function chunk(c: object): SSERecord {
  return { data: JSON.stringify(c) };
}

test("text-only stream concatenates content deltas", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({ id: "c1", choices: [{ delta: { content: "Hi" } }] }),
        chunk({ id: "c1", choices: [{ delta: { content: " there" } }] }),
        chunk({ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
        { data: "[DONE]" },
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "c1" },
    { type: "text_delta", index: 0, text: "Hi" },
    { type: "text_delta", index: 0, text: " there" },
    {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
      content: [{ type: "text", text: "Hi there" }],
    },
  ]);
});

test("indexed tool_calls accumulate across deltas", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({
          id: "c2",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } },
                ],
              },
            },
          ],
        }),
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
              },
            },
          ],
        }),
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ':"Oslo"}' } }],
              },
            },
          ],
        }),
        chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }),
        { data: "[DONE]" },
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "c2" },
    { type: "tool_use_start", index: 0, id: "call_abc", name: "get_weather" },
    { type: "tool_use_stop", index: 0, input: { city: "Oslo" } },
    {
      type: "message_stop",
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 7 },
      content: [
        { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "Oslo" } },
      ],
    },
  ]);
});

test("missing tool_calls index falls back to array position", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({
          id: "c3",
          choices: [
            {
              delta: {
                tool_calls: [
                  // no index field — adapter must use arrPos 0
                  { id: "call_x", type: "function", function: { name: "ping", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
        chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        { data: "[DONE]" },
      ),
    ),
  );

  const start = events.find((e) => e.type === "tool_use_start");
  assert.deepEqual(start, { type: "tool_use_start", index: 0, id: "call_x", name: "ping" });
  const stop = events.find((e) => e.type === "tool_use_stop");
  assert.deepEqual(stop, { type: "tool_use_stop", index: 0, input: {} });
});

test("id and name split across two chunks delays start emission", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({
          id: "c4",
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_y" }] } }],
        }),
        chunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "x", arguments: "{}" } }] } }],
        }),
        chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        { data: "[DONE]" },
      ),
    ),
  );

  // tool_use_start must appear exactly once and only after both id+name landed
  const starts = events.filter((e) => e.type === "tool_use_start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0], { type: "tool_use_start", index: 0, id: "call_y", name: "x" });
});

test("malformed args fall back to { _raw }", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({ id: "c5", choices: [{ delta: { tool_calls: [{ index: 0, id: "i", type: "function", function: { name: "n", arguments: "{not" } }] } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        { data: "[DONE]" },
      ),
    ),
  );

  const stop = events.find((e) => e.type === "tool_use_stop") as Extract<
    StreamEvent,
    { type: "tool_use_stop" }
  >;
  assert.deepEqual(stop.input, { _raw: "{not" });
});

test("reasoning + text deltas both flow", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        chunk({ id: "c6", choices: [{ delta: { reasoning_content: "think" } }] }),
        chunk({ choices: [{ delta: { content: "answer" } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        { data: "[DONE]" },
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "message_start", id: "c6" },
    { type: "reasoning_delta", index: 0, text: "think" },
    { type: "text_delta", index: 1, text: "answer" },
    {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "answer" },
      ],
    },
  ]);
});
