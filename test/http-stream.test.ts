import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createSpecialist,
  createStreamingChatHandler,
  inMemoryStore,
} from "../src/index.ts";
import type { ChatStreamEvent, StreamEvent } from "../src/index.ts";
import {
  mockStreamProvider,
  streamText,
  streamToolUse,
  streamTurn,
} from "./_mock.ts";

const weather = createSpecialist({
  name: "weather",
  description: "weather questions",
  role: "weather agent",
  tools: [],
});

const math = createSpecialist({
  name: "math",
  description: "math questions",
  role: "math agent",
  tools: [],
});

async function drain(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

test("routes correctly and streams text deltas", async () => {
  const llm = mockStreamProvider([
    streamTurn([streamText("weather")], "end_turn"),
    streamTurn([streamText("It is "), streamText("sunny.")], "end_turn"),
  ]);
  const handler = createStreamingChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });

  const events = await drain(handler({ sessionId: "s1", message: "weather?" }));
  const types = events.map((e) => e.type);

  assert.equal(types[0], "routed");
  assert.equal(types[types.length - 1], "done");
  const deltas = events.filter((e) => e.type === "text_delta") as Extract<
    ChatStreamEvent,
    { type: "text_delta" }
  >[];
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].text, "It is ");
  assert.equal(deltas[1].text, "sunny.");

  const done = events[events.length - 1] as Extract<ChatStreamEvent, { type: "done" }>;
  assert.equal(done.reply, "It is sunny.");
  assert.equal(done.routedTo, "weather");
});

test("persists only the safe text pair, never tool transcripts", async () => {
  const tool = {
    name: "echo",
    description: "",
    inputSchema: {},
    handler: () => "x",
  };
  const weatherWithTool = createSpecialist({
    name: "weather",
    description: "weather questions",
    role: "r",
    tools: [tool],
  });

  const llm = mockStreamProvider([
    streamTurn([streamText("weather")], "end_turn"),
    streamTurn([streamToolUse("u1", "echo", {}, 0)], "tool_use"),
    streamTurn([streamText("final")], "end_turn"),
  ]);
  const store = inMemoryStore();
  const handler = createStreamingChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weatherWithTool, math],
    services: {},
    store,
  });

  await drain(handler({ sessionId: "s", message: "first" }));

  const persisted = await store.get("s");
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].role, "user");
  assert.equal(persisted[1].role, "assistant");
  const assistantContent = persisted[1].role === "assistant" ? persisted[1].content : [];
  assert.equal(assistantContent.length, 1);
  assert.equal(assistantContent[0].type, "text");
});

test("history is threaded into router and specialist on subsequent calls", async () => {
  const llm = mockStreamProvider([
    streamTurn([streamText("weather")], "end_turn"),
    streamTurn([streamText("first")], "end_turn"),
    streamTurn([streamText("weather")], "end_turn"),
    streamTurn([streamText("second")], "end_turn"),
  ]);
  const handler = createStreamingChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });

  await drain(handler({ sessionId: "s", message: "one" }));
  await drain(handler({ sessionId: "s", message: "two" }));

  const routerTurn2 = llm.calls[2].messages;
  assert.equal(routerTurn2.length, 3);
  assert.deepEqual(routerTurn2[0], { role: "user", content: "one" });
  assert.equal(routerTurn2[1].role, "assistant");
  assert.deepEqual(routerTurn2[2], { role: "user", content: "two" });
});

test("aborting mid-stream throws and does not persist", async () => {
  const ctrl = new AbortController();
  const llm = {
    calls: [] as never[],
    async complete() {
      // router call — return "weather"
      return {
        content: [{ type: "text" as const, text: "weather" }],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *stream(_req: unknown, opts?: { signal?: AbortSignal }) {
      yield { type: "message_start" } as StreamEvent;
      yield { type: "text_delta", index: 0, text: "hello" } as StreamEvent;
      ctrl.abort();
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      yield { type: "text_delta", index: 0, text: " more" } as StreamEvent;
    },
  };

  const store = inMemoryStore();
  const handler = createStreamingChatHandler({
    llm: llm as never,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store,
  });

  const events: ChatStreamEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const ev of handler(
        { sessionId: "s", message: "hi" },
        { signal: ctrl.signal },
      )) {
        events.push(ev);
      }
    },
    (e: Error) => e.name === "AbortError",
  );

  assert.equal(events[0].type, "routed");
  assert.equal(events.find((e) => e.type === "done"), undefined);
  assert.equal((await store.get("s")).length, 0);
});

test("empty specialists list throws", async () => {
  const llm = mockStreamProvider([streamTurn([streamText("x")], "end_turn")]);
  const handler = createStreamingChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [],
    services: {},
    store: inMemoryStore(),
  });
  await assert.rejects(
    async () => {
      for await (const _ of handler({ sessionId: "s", message: "x" })) {
        void _;
      }
    },
    /specialists must be non-empty/,
  );
});

test("router unknown intent → falls back to first specialist", async () => {
  const llm = mockStreamProvider([
    streamTurn([streamText("banana")], "end_turn"),
    streamTurn([streamText("ok")], "end_turn"),
  ]);
  const handler = createStreamingChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });
  const events = await drain(handler({ sessionId: "s", message: "x" }));
  const routed = events.find((e) => e.type === "routed") as Extract<
    ChatStreamEvent,
    { type: "routed" }
  >;
  assert.equal(routed.routedTo, "weather");
});
