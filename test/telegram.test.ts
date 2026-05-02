import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createWebhookHandler,
  processUpdate,
  runPolling,
} from "../src/channel/telegram.ts";
import type { TelegramUpdate } from "../src/channel/telegram.ts";
import type { ChatHandler } from "../src/index.ts";

interface Recorded {
  url: string;
  init?: RequestInit;
}

function recordingFetch(responder: (url: string, init?: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const baseUpdate = (text: string, chatId = 42, updateId = 1): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    chat: { id: chatId, type: "private" },
    text,
  },
});

test("processUpdate dispatches text → handler + sendMessage", async () => {
  const seen: { sessionId: string; message: string }[] = [];
  const handler: ChatHandler = async (req) => {
    seen.push(req);
    return { reply: "hi back", routedTo: "weather" };
  };
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  await processUpdate(baseUpdate("hi"), {
    token: "T",
    handler,
    fetch,
  });
  assert.deepEqual(seen, [{ sessionId: "42", message: "hi" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botT\/sendMessage$/);
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, { chat_id: 42, text: "hi back" });
});

test("processUpdate skips non-text updates", async () => {
  let handlerCalled = false;
  const handler: ChatHandler = async () => {
    handlerCalled = true;
    return { reply: "x", routedTo: "weather" };
  };
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));

  await processUpdate({ update_id: 1 }, { token: "T", handler, fetch });
  await processUpdate(
    { update_id: 2, message: { message_id: 2, chat: { id: 1, type: "private" } } },
    { token: "T", handler, fetch },
  );
  assert.equal(handlerCalled, false);
  assert.equal(calls.length, 0);
});

test("processUpdate truncates long replies", async () => {
  const long = "a".repeat(5000);
  const handler: ChatHandler = async () => ({ reply: long, routedTo: "weather" });
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  await processUpdate(baseUpdate("hi"), { token: "T", handler, fetch });
  const body = JSON.parse(calls[0].init?.body as string);
  assert.ok(body.text.length <= 4096, `text length was ${body.text.length}`);
  assert.ok(body.text.endsWith("…[truncated]"));
});

test("processUpdate: handler throw → onError, no rethrow", async () => {
  const errs: unknown[] = [];
  const handler: ChatHandler = async () => {
    throw new Error("boom");
  };
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  await processUpdate(baseUpdate("hi"), {
    token: "T",
    handler,
    fetch,
    onError: (e) => errs.push(e),
  });
  assert.equal(errs.length, 1);
  assert.equal((errs[0] as Error).message, "boom");
  assert.equal(calls.length, 0);
});

test("processUpdate: sendMessage failure → onError, no rethrow", async () => {
  const errs: unknown[] = [];
  const handler: ChatHandler = async () => ({ reply: "x", routedTo: "weather" });
  const { fetch } = recordingFetch(
    () => new Response("nope", { status: 500 }),
  );
  await processUpdate(baseUpdate("hi"), {
    token: "T",
    handler,
    fetch,
    onError: (e) => errs.push(e),
  });
  assert.equal(errs.length, 1);
  assert.match(String((errs[0] as Error).message), /500/);
});

test("processUpdate: sessionId derives from chat.id", async () => {
  const seen: string[] = [];
  const handler: ChatHandler = async (req) => {
    seen.push(req.sessionId);
    return { reply: "ok", routedTo: "weather" };
  };
  const { fetch } = recordingFetch(() => okJson({ ok: true }));
  await processUpdate(baseUpdate("a", 100, 1), { token: "T", handler, fetch });
  await processUpdate(baseUpdate("b", 200, 2), { token: "T", handler, fetch });
  assert.deepEqual(seen, ["100", "200"]);
});

test("runPolling advances offset past largest update_id", async () => {
  const ctrl = new AbortController();
  const handler: ChatHandler = async () => ({ reply: "ok", routedTo: "weather" });
  let getUpdatesCount = 0;
  const seenOffsets: string[] = [];
  const { fetch } = recordingFetch((url) => {
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      const m = url.match(/offset=(\d+)/);
      if (m) seenOffsets.push(m[1]);
      if (getUpdatesCount === 1) {
        return okJson({
          ok: true,
          result: [baseUpdate("a", 1, 5), baseUpdate("b", 1, 6), baseUpdate("c", 1, 7)],
        });
      }
      ctrl.abort();
      return okJson({ ok: true, result: [] });
    }
    return okJson({ ok: true });
  });

  await runPolling({
    token: "T",
    handler,
    fetch,
    signal: ctrl.signal,
    pollTimeout: 0,
  });

  assert.ok(seenOffsets.length >= 2, `got offsets: ${seenOffsets.join(",")}`);
  assert.equal(seenOffsets[0], "0");
  assert.equal(seenOffsets[1], "8");
});

test("runPolling exits cleanly on abort", async () => {
  const ctrl = new AbortController();
  const handler: ChatHandler = async () => ({ reply: "ok", routedTo: "weather" });
  let getUpdatesCount = 0;
  const { fetch, calls } = recordingFetch((url) => {
    if (url.includes("/getUpdates")) {
      getUpdatesCount++;
      if (getUpdatesCount === 1) {
        ctrl.abort();
        return okJson({ ok: true, result: [] });
      }
      throw new Error("should not reach second getUpdates");
    }
    return okJson({ ok: true });
  });

  await runPolling({
    token: "T",
    handler,
    fetch,
    signal: ctrl.signal,
    pollTimeout: 0,
  });

  assert.equal(getUpdatesCount, 1);
  assert.equal(calls.filter((c) => c.url.includes("/getUpdates")).length, 1);
});

test("webhook: valid update dispatches → 200", async () => {
  const seen: { sessionId: string; message: string }[] = [];
  const handler: ChatHandler = async (req) => {
    seen.push(req);
    return { reply: "ok", routedTo: "weather" };
  };
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  const wh = createWebhookHandler({ token: "T", handler, fetch });

  const res = await wh({
    headers: {},
    json: async () => baseUpdate("hi", 9, 1),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ sessionId: "9", message: "hi" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
});

test("webhook: missing/invalid secret token → 401, no dispatch", async () => {
  let called = false;
  const handler: ChatHandler = async () => {
    called = true;
    return { reply: "x", routedTo: "weather" };
  };
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  const wh = createWebhookHandler({
    token: "T",
    handler,
    fetch,
    secretToken: "shh",
  });

  const r1 = await wh({ headers: {}, json: async () => baseUpdate("hi") });
  assert.equal(r1.status, 401);

  const r2 = await wh({
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    json: async () => baseUpdate("hi"),
  });
  assert.equal(r2.status, 401);

  assert.equal(called, false);
  assert.equal(calls.length, 0);
});

test("webhook: correct secret token passes", async () => {
  const handler: ChatHandler = async () => ({ reply: "ok", routedTo: "weather" });
  const { fetch } = recordingFetch(() => okJson({ ok: true }));
  const wh = createWebhookHandler({
    token: "T",
    handler,
    fetch,
    secretToken: "shh",
  });
  const res = await wh({
    headers: { "x-telegram-bot-api-secret-token": "shh" },
    json: async () => baseUpdate("hi"),
  });
  assert.equal(res.status, 200);
});

test("webhook: malformed JSON → 400, onError called", async () => {
  const errs: unknown[] = [];
  const handler: ChatHandler = async () => ({ reply: "x", routedTo: "weather" });
  const { fetch, calls } = recordingFetch(() => okJson({ ok: true }));
  const wh = createWebhookHandler({
    token: "T",
    handler,
    fetch,
    onError: (e) => errs.push(e),
  });
  const res = await wh({
    headers: {},
    json: async () => {
      throw new SyntaxError("bad json");
    },
  });
  assert.equal(res.status, 400);
  assert.equal(errs.length, 1);
  assert.equal(calls.length, 0);
});

test("webhook: Headers object (Web Fetch API) is accepted", async () => {
  const handler: ChatHandler = async () => ({ reply: "ok", routedTo: "weather" });
  const { fetch } = recordingFetch(() => okJson({ ok: true }));
  const wh = createWebhookHandler({
    token: "T",
    handler,
    fetch,
    secretToken: "shh",
  });
  const headers = new Headers({ "x-telegram-bot-api-secret-token": "shh" });
  const res = await wh({ headers, json: async () => baseUpdate("hi") });
  assert.equal(res.status, 200);
});
