import { test } from "node:test";
import assert from "node:assert/strict";
import { streamAgent, type AgentEvent, type ToolDef } from "../src/agent/run.ts";
import type { StreamEvent } from "../src/llm/types.ts";
import { mockStreamProvider, streamText, streamToolUse, streamTurn, userMsg } from "./_mock.ts";

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("single text turn → final text matches concatenated deltas", async () => {
  const llm = mockStreamProvider([
    [
      { type: "message_start" },
      { type: "text_delta", index: 0, text: "Hello " },
      { type: "text_delta", index: 0, text: "world" },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 2 },
        content: [{ type: "text", text: "Hello world" }],
      },
    ],
  ]);

  const events = await drain(
    streamAgent({
      llm,
      model: "test",
      tools: [],
      messages: [userMsg("hi")],
    }),
  );

  const done = events.find((e) => e.type === "agent_done") as Extract<AgentEvent, { type: "agent_done" }>;
  assert.equal(done.result.finalText, "Hello world");
  assert.equal(done.result.stopReason, "end_turn");
  assert.equal(done.result.iterations, 1);

  const textDeltas = events.filter((e) => e.type === "text_delta") as Array<
    Extract<StreamEvent, { type: "text_delta" }>
  >;
  assert.equal(textDeltas.map((e) => e.text).join(""), "Hello world");
});

test("tool call → result → text — tool_dispatch events bracket the tool execution", async () => {
  const tool: ToolDef = {
    name: "get_weather",
    description: "weather",
    inputSchema: { type: "object" },
    handler: async (input) => `22°C in ${(input as { city: string }).city}`,
  };

  const llm = mockStreamProvider([
    streamTurn(
      [streamText("looking..."), streamToolUse("tu_1", "get_weather", { city: "Oslo" }, 1)],
      "tool_use",
    ),
    streamTurn([streamText("It is 22°C in Oslo.")], "end_turn"),
  ]);

  const events = await drain(
    streamAgent({
      llm,
      model: "test",
      tools: [tool],
      messages: [userMsg("weather?")],
    }),
  );

  const types = events.map((e) => e.type);
  const dispatchStartIdx = types.indexOf("tool_dispatch_start");
  const dispatchDoneIdx = types.indexOf("tool_dispatch_done");
  const secondMessageStartIdx = types.lastIndexOf("message_start");

  assert.ok(dispatchStartIdx > 0, "tool_dispatch_start must appear");
  assert.ok(dispatchDoneIdx > dispatchStartIdx, "done must follow start");
  assert.ok(
    secondMessageStartIdx > dispatchDoneIdx,
    "second turn message_start must follow tool_dispatch_done",
  );

  const dispatchDone = events.find((e) => e.type === "tool_dispatch_done") as Extract<
    AgentEvent,
    { type: "tool_dispatch_done" }
  >;
  assert.deepEqual(dispatchDone, {
    type: "tool_dispatch_done",
    toolUseId: "tu_1",
    content: "22°C in Oslo",
    isError: false,
  });

  const done = events.find((e) => e.type === "agent_done") as Extract<AgentEvent, { type: "agent_done" }>;
  assert.equal(done.result.finalText, "It is 22°C in Oslo.");
  assert.equal(done.result.iterations, 2);
});

test("parallel tool calls — both starts before any done", async () => {
  const tool: ToolDef = {
    name: "ping",
    description: "ping",
    inputSchema: { type: "object" },
    handler: async (input) => `pong:${(input as { id: string }).id}`,
  };

  const llm = mockStreamProvider([
    streamTurn(
      [
        streamToolUse("tu_a", "ping", { id: "a" }, 0),
        streamToolUse("tu_b", "ping", { id: "b" }, 1),
      ],
      "tool_use",
    ),
    streamTurn([streamText("done")], "end_turn"),
  ]);

  const events = await drain(
    streamAgent({
      llm,
      model: "test",
      tools: [tool],
      messages: [userMsg("go")],
    }),
  );

  const startIndices = events
    .map((e, i) => (e.type === "tool_dispatch_start" ? i : -1))
    .filter((i) => i >= 0);
  const doneIndices = events
    .map((e, i) => (e.type === "tool_dispatch_done" ? i : -1))
    .filter((i) => i >= 0);

  assert.equal(startIndices.length, 2);
  assert.equal(doneIndices.length, 2);
  // Both starts must precede both dones
  assert.ok(Math.max(...startIndices) < Math.min(...doneIndices));

  // Both dispatch_done events must appear before next iteration's message_start
  const types = events.map((e) => e.type);
  const secondMessageStart = types.lastIndexOf("message_start");
  assert.ok(secondMessageStart > Math.max(...doneIndices));
});

test("tool handler throws → isError: true, loop continues", async () => {
  const tool: ToolDef = {
    name: "broken",
    description: "always throws",
    inputSchema: { type: "object" },
    handler: () => {
      throw new Error("kaboom");
    },
  };

  const llm = mockStreamProvider([
    streamTurn([streamToolUse("tu_e", "broken", {}, 0)], "tool_use"),
    streamTurn([streamText("recovered")], "end_turn"),
  ]);

  const events = await drain(
    streamAgent({
      llm,
      model: "test",
      tools: [tool],
      messages: [userMsg("try")],
    }),
  );

  const done = events.find((e) => e.type === "tool_dispatch_done") as Extract<
    AgentEvent,
    { type: "tool_dispatch_done" }
  >;
  assert.equal(done.isError, true);
  assert.equal(done.content, "kaboom");

  const finished = events.find((e) => e.type === "agent_done") as Extract<
    AgentEvent,
    { type: "agent_done" }
  >;
  assert.equal(finished.result.stopReason, "end_turn");
  assert.equal(finished.result.iterations, 2);
});

test("reasoning delta — assembled content includes reasoning block", async () => {
  const llm = mockStreamProvider([
    [
      { type: "message_start" },
      { type: "reasoning_delta", index: 0, text: "thinking..." },
      { type: "text_delta", index: 1, text: "answer" },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "answer" },
        ],
      },
    ],
  ]);

  const events = await drain(
    streamAgent({ llm, model: "test", tools: [], messages: [userMsg("?")] }),
  );

  const stop = events.find((e) => e.type === "message_stop") as Extract<
    StreamEvent,
    { type: "message_stop" }
  >;
  assert.deepEqual(stop.content, [
    { type: "reasoning", text: "thinking..." },
    { type: "text", text: "answer" },
  ]);

  const done = events.find((e) => e.type === "agent_done") as Extract<AgentEvent, { type: "agent_done" }>;
  assert.equal(done.result.finalText, "answer"); // reasoning excluded from finalText
});

test("abort signal mid-stream → throws, no further events", async () => {
  // Mock that respects abort during iteration
  const ctrl = new AbortController();
  const llm = {
    calls: [] as never[],
    async complete(): Promise<never> {
      throw new Error("not used");
    },
    async *stream(_req: unknown, opts?: { signal?: AbortSignal }) {
      yield { type: "message_start" } as StreamEvent;
      yield { type: "text_delta", index: 0, text: "hello" } as StreamEvent;
      // Abort BEFORE sending the next event — we check signal between yields
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      ctrl.abort();
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      yield { type: "text_delta", index: 0, text: " more" } as StreamEvent;
    },
  };

  const events: AgentEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const ev of streamAgent({
        llm: llm as never,
        model: "test",
        tools: [],
        messages: [userMsg("hi")],
        signal: ctrl.signal,
      })) {
        events.push(ev);
      }
    },
    (e: Error) => e.name === "AbortError",
  );

  // First two events should have arrived
  assert.equal(events[0].type, "message_start");
  assert.equal(events[1].type, "text_delta");
  // No agent_done should appear
  assert.equal(events.find((e) => e.type === "agent_done"), undefined);
});

test("max_iterations: returns with stopReason: max_iterations", async () => {
  const tool: ToolDef = {
    name: "loop",
    description: "always returns",
    inputSchema: { type: "object" },
    handler: () => "ok",
  };

  const llm = mockStreamProvider([
    streamTurn([streamToolUse("t1", "loop", {}, 0)], "tool_use"),
    streamTurn([streamToolUse("t2", "loop", {}, 0)], "tool_use"),
    streamTurn([streamToolUse("t3", "loop", {}, 0)], "tool_use"),
  ]);

  const events = await drain(
    streamAgent({
      llm,
      model: "test",
      tools: [tool],
      messages: [userMsg("loop")],
      maxIterations: 2,
    }),
  );

  const done = events.find((e) => e.type === "agent_done") as Extract<
    AgentEvent,
    { type: "agent_done" }
  >;
  assert.equal(done.result.stopReason, "max_iterations");
  assert.equal(done.result.iterations, 2);
});
