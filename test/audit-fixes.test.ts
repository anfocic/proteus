import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createChatHandler,
  createSpecialist,
  inMemoryStore,
  LLMServerError,
  runAgent,
  streamAgent,
  withRetry,
} from "../src/index.ts";
import type { LLMProvider, Message, SessionStore, ToolDef } from "../src/index.ts";
import type { CompletionRequest } from "../src/llm/types.ts";
import { parseSSE } from "../src/llm/sse.ts";
import { createWebhookHandler, runPolling } from "../src/channel/telegram.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";
import { mockStreamProvider, streamToolUse, streamTurn } from "./_mock.ts";

const baseReq: CompletionRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

// --- #2: signal threads into runAgent's complete() call ---

test("runAgent rejects when its signal is already aborted", async () => {
  const llm = mockProvider([response([text("hi")], "end_turn")]);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    runAgent({ llm, model: "m", tools: [], messages: [userMsg("hi")], signal: ctrl.signal }),
    (err: unknown) => err instanceof DOMException && err.name === "AbortError",
  );
});

// --- #1: withRetry closes the abandoned stream generator before retrying ---

test("withRetry closes the abandoned stream generator before a retry", async () => {
  let returnCalls = 0;
  let attempt = 0;
  const llm: LLMProvider = {
    async complete() {
      throw new Error("unused");
    },
    stream() {
      attempt++;
      const failFirst = attempt === 1;
      return {
        async next() {
          if (failFirst) {
            throw new LLMServerError({ provider: "anthropic", message: "boom", phase: "stream" });
          }
          return { done: true, value: undefined };
        },
        async return() {
          returnCalls++;
          return { done: true, value: undefined };
        },
        async throw(e: unknown) {
          throw e;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
  const wrapped = withRetry(llm, { baseMs: 0, jitter: false });
  for await (const _ of wrapped.stream(baseReq)) {
    // drain
  }
  assert.equal(attempt, 2, "should have retried once");
  assert.equal(returnCalls, 1, "abandoned generator should be closed exactly once");
});

// --- #4: parseSSE bails instead of growing its buffer unbounded ---

test("parseSSE throws when a record has no delimiter past the cap", async () => {
  const chunk = new TextEncoder().encode("a".repeat(1024 * 1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      ctrl.enqueue(chunk);
    },
  });
  await assert.rejects(
    (async () => {
      for await (const _ of parseSSE(stream)) {
        // drain
      }
    })(),
    /SSE buffer exceeded/,
  );
});

// --- #5: streamAgent throws on a 'pending' decision without a fake agent_done ---

test("streamAgent throws on 'pending' and never yields agent_done", async () => {
  const tool: ToolDef = {
    name: "wipe",
    description: "destructive",
    inputSchema: { type: "object" },
    requiresConfirmation: true,
    handler: () => "done",
  };
  const llm = mockStreamProvider([
    streamTurn([streamToolUse("t1", "wipe", {})], "tool_use"),
  ]);
  const events: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const ev of streamAgent({
        llm,
        model: "m",
        tools: [tool],
        messages: [userMsg("wipe it")],
        confirm: async () => "pending",
      })) {
        events.push(ev.type);
      }
    })(),
    /does not support 'pending'/,
  );
  assert.equal(events.includes("agent_done"), false, "must not emit a terminal event before throwing");
});

// --- #3: chat handler persists the user/assistant pair in one append ---

test("chat handler appends the user/assistant pair atomically", async () => {
  const appends: Message[][] = [];
  const inner = inMemoryStore();
  const store: SessionStore = {
    get: inner.get,
    append: async (id, msgs) => {
      appends.push(msgs);
      return inner.append(id, msgs);
    },
  };
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([text("sunny")], "end_turn"),
  ]);
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [
      createSpecialist({ name: "weather", description: "weather", role: "weather", tools: [] }),
    ],
    services: {},
    store,
  });
  await handler({ sessionId: "x", message: "weather?" });
  assert.equal(appends.length, 1, "exactly one append call on the reply path");
  assert.deepEqual(
    appends[0].map((m) => m.role),
    ["user", "assistant"],
  );
});

// --- #14: chat handler surfaces a suspension with no pendingStore loudly ---

test("chat handler throws when orchestrate suspends without a pendingStore", async () => {
  const tool: ToolDef = {
    name: "wipe",
    description: "destructive",
    inputSchema: { type: "object" },
    requiresConfirmation: true,
    handler: () => "done",
  };
  const llm = mockProvider([
    response([text("danger")], "end_turn"),
    response([toolUse("t1", "wipe", {})], "tool_use"),
  ]);
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [
      createSpecialist({
        name: "danger",
        description: "destructive ops",
        role: "danger",
        tools: [tool],
      }),
    ],
    services: {},
    store: inMemoryStore(),
    confirm: async () => "pending",
  });
  await assert.rejects(handler({ sessionId: "x", message: "wipe it" }), /no pendingStore/);
});

// --- #6: webhook secret check is constant-time and still correct ---

test("webhook handler accepts the matching secret and rejects a mismatch", async () => {
  const handler = createWebhookHandler({
    token: "t",
    handler: async () => ({ kind: "reply", reply: "", routedTo: "" }),
    secretToken: "s3cret",
  });
  const ok = await handler({
    headers: { "x-telegram-bot-api-secret-token": "s3cret" },
    json: async () => ({ update_id: 1 }),
  });
  assert.equal(ok.status, 200);
  const bad = await handler({
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    json: async () => ({ update_id: 1 }),
  });
  assert.equal(bad.status, 401);
  const missing = await handler({
    headers: {},
    json: async () => ({ update_id: 1 }),
  });
  assert.equal(missing.status, 401);
});

// --- #7: the bot token never reaches the error reporter ---

test("runPolling redacts the bot token from reported errors", async () => {
  const token = "123456:SUPERSECRETTOKEN";
  const ctrl = new AbortController();
  let reported: unknown;
  await runPolling({
    token,
    handler: async () => ({ kind: "reply", reply: "", routedTo: "" }),
    signal: ctrl.signal,
    fetch: (async (url: string) => {
      throw new Error(`request to ${url} failed`);
    }) as typeof fetch,
    onError: (err) => {
      reported = err;
      ctrl.abort();
    },
  });
  assert.ok(reported instanceof Error);
  assert.equal((reported as Error).message.includes(token), false, "token must be redacted");
  assert.match((reported as Error).message, /<token>/);
});
