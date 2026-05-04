import { test } from "node:test";
import assert from "node:assert/strict";
import { streamFromAnthropicSSE } from "../src/llm/anthropic.ts";
import { streamFromOpenAISSE } from "../src/llm/openai-compat.ts";
import type { SSERecord } from "../src/llm/sse.ts";
import type { CompletionResponse, StreamEvent, Usage } from "../src/llm/types.ts";
import { addUsage, runAgent, zeroUsage } from "../src/index.ts";
import { mockProvider, text, toolUse, userMsg } from "./_mock.ts";

async function* records(...items: SSERecord[]): AsyncGenerator<SSERecord> {
  for (const r of items) yield r;
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function arec(event: string, data: unknown): SSERecord {
  return { event, data: JSON.stringify(data) };
}

function ochunk(c: object): SSERecord {
  return { data: JSON.stringify(c) };
}

test("addUsage: undefined + undefined keeps cache fields undefined", () => {
  const a: Usage = { inputTokens: 1, outputTokens: 2 };
  const b: Usage = { inputTokens: 3, outputTokens: 4 };
  const sum = addUsage(a, b);
  assert.equal(sum.cacheCreationInputTokens, undefined);
  assert.equal(sum.cacheReadInputTokens, undefined);
});

test("addUsage: defined + undefined treats undefined as 0", () => {
  const a: Usage = { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 50 };
  const b: Usage = { inputTokens: 1, outputTokens: 0 };
  const sum = addUsage(a, b);
  assert.equal(sum.cacheReadInputTokens, 50);
  assert.equal(sum.cacheCreationInputTokens, undefined);
});

test("addUsage: sums both cache fields when present on both sides", () => {
  const a: Usage = {
    inputTokens: 1,
    outputTokens: 0,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
  };
  const b: Usage = {
    inputTokens: 1,
    outputTokens: 0,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 20,
  };
  const sum = addUsage(a, b);
  assert.equal(sum.cacheCreationInputTokens, 110);
  assert.equal(sum.cacheReadInputTokens, 220);
});

test("zeroUsage has no cache fields", () => {
  const z = zeroUsage();
  assert.equal(z.cacheCreationInputTokens, undefined);
  assert.equal(z.cacheReadInputTokens, undefined);
});

test("anthropic stream: cache_creation + cache_read surface from message_start", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        arec("message_start", {
          type: "message_start",
          message: {
            id: "msg_c",
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 1024,
              cache_read_input_tokens: 2048,
            },
          },
        }),
        arec("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        arec("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        arec("content_block_stop", { type: "content_block_stop", index: 0 }),
        arec("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
        arec("message_stop", { type: "message_stop" }),
      ),
    ),
  );
  const stop = events.find((e) => e.type === "message_stop");
  assert.ok(stop && stop.type === "message_stop");
  assert.equal(stop.usage.cacheCreationInputTokens, 1024);
  assert.equal(stop.usage.cacheReadInputTokens, 2048);
  assert.equal(stop.usage.inputTokens, 10);
  assert.equal(stop.usage.outputTokens, 4);
});

test("anthropic stream: omits cache fields when not in payload", async () => {
  const events = await drain(
    streamFromAnthropicSSE(
      records(
        arec("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 5, output_tokens: 0 } } }),
        arec("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        arec("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
        arec("content_block_stop", { type: "content_block_stop", index: 0 }),
        arec("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        arec("message_stop", { type: "message_stop" }),
      ),
    ),
  );
  const stop = events.find((e) => e.type === "message_stop");
  assert.ok(stop && stop.type === "message_stop");
  assert.equal(stop.usage.cacheCreationInputTokens, undefined);
  assert.equal(stop.usage.cacheReadInputTokens, undefined);
});

test("openai stream: prompt_tokens_details.cached_tokens → cacheReadInputTokens", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        ochunk({ id: "c1", choices: [{ delta: { content: "hi" } }] }),
        ochunk({
          id: "c1",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
        { data: "[DONE]" },
      ),
    ),
  );
  const stop = events.find((e) => e.type === "message_stop");
  assert.ok(stop && stop.type === "message_stop");
  assert.equal(stop.usage.cacheReadInputTokens, 80);
  assert.equal(stop.usage.cacheCreationInputTokens, undefined);
});

test("openai stream: omits cache field when host doesn't report it", async () => {
  const events = await drain(
    streamFromOpenAISSE(
      records(
        ochunk({ id: "c1", choices: [{ delta: { content: "hi" } }] }),
        ochunk({ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        { data: "[DONE]" },
      ),
    ),
  );
  const stop = events.find((e) => e.type === "message_stop");
  assert.ok(stop && stop.type === "message_stop");
  assert.equal(stop.usage.cacheReadInputTokens, undefined);
});

test("runAgent: cache fields aggregate across iterations", async () => {
  const turn = (
    content: CompletionResponse["content"],
    stopReason: CompletionResponse["stopReason"],
    usage: Usage,
  ): CompletionResponse => ({ content, stopReason, usage });

  const llm = mockProvider([
    turn([toolUse("u1", "t", {})], "tool_use", {
      inputTokens: 50,
      outputTokens: 8,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 0,
    }),
    turn([text("done")], "end_turn", {
      inputTokens: 60,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
    }),
  ]);
  const res = await runAgent({
    llm,
    model: "m",
    tools: [{ name: "t", description: "", inputSchema: {}, handler: () => "ok" }],
    messages: [userMsg("go")],
  });
  assert.equal(res.usage.cacheCreationInputTokens, 1000);
  assert.equal(res.usage.cacheReadInputTokens, 1000);
  assert.equal(res.usage.inputTokens, 110);
  assert.equal(res.usage.outputTokens, 12);
});
