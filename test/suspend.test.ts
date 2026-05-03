import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createChatHandler,
  createSpecialist,
  inMemoryPendingStore,
  inMemoryStore,
  resumeAgent,
  runAgent,
  type ChatHandler,
  type ConfirmCallback,
  type ToolDef,
} from "../src/index.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

const writeTool = (
  name: string,
  hits: { count: number },
): ToolDef => ({
  name,
  description: "",
  inputSchema: {},
  requiresConfirmation: true,
  summarize: (input) => `do ${name}(${JSON.stringify(input)})`,
  handler: async () => {
    hits.count++;
    return `${name}-ok`;
  },
});

const pendingConfirm: ConfirmCallback = async () => "pending";

test("runAgent: confirm returns 'pending' → suspended payload", async () => {
  const llm = mockProvider([response([toolUse("u1", "wt", { id: 7 })], "tool_use")]);
  const hits = { count: 0 };
  const result = await runAgent({
    llm,
    model: "m",
    tools: [writeTool("wt", hits)],
    messages: [userMsg("delete user 7")],
    confirm: pendingConfirm,
  });
  assert.equal(result.stopReason, "pending");
  assert.equal(hits.count, 0, "handler must not run before confirmation");
  assert.ok(result.suspended);
  assert.equal(result.suspended.pending.toolUseId, "u1");
  assert.equal(result.suspended.pending.name, "wt");
  assert.equal(result.suspended.pending.summary, 'do wt({"id":7})');
  assert.equal(result.suspended.iteration, 1);
  assert.equal(
    result.messages.find((m) => m.role === "assistant"),
    undefined,
    "no assistant turn should be persisted on suspension",
  );
});

test("resumeAgent: approve → handler runs, loop continues to end_turn", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "wt", { id: 7 })], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const hits = { count: 0 };
  const tools = [writeTool("wt", hits)];
  const first = await runAgent({
    llm,
    model: "m",
    tools,
    messages: [userMsg("delete user 7")],
    confirm: pendingConfirm,
  });
  assert.ok(first.suspended);

  const resumed = await resumeAgent({
    llm,
    model: "m",
    tools,
    suspended: first.suspended,
    resume: { toolUseId: "u1", decision: "approve" },
  });
  assert.equal(resumed.stopReason, "end_turn");
  assert.equal(resumed.finalText, "done");
  assert.equal(hits.count, 1);
  // last 3 messages should be: user, assistant(tool_use), tool_result, assistant(text)
  const roles = resumed.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool_result", "assistant"]);
});

test("resumeAgent: decline → DECLINED tool_result, loop continues, handler not run", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "wt", { id: 7 })], "tool_use"),
    response([text("ok, skipped")], "end_turn"),
  ]);
  const hits = { count: 0 };
  const tools = [writeTool("wt", hits)];
  const first = await runAgent({
    llm,
    model: "m",
    tools,
    messages: [userMsg("delete user 7")],
    confirm: pendingConfirm,
  });
  const resumed = await resumeAgent({
    llm,
    model: "m",
    tools,
    suspended: first.suspended!,
    resume: { toolUseId: "u1", decision: "decline" },
  });
  assert.equal(hits.count, 0);
  const tr = resumed.messages.find((m) => m.role === "tool_result");
  assert.ok(tr && tr.role === "tool_result");
  assert.match(tr.content, /^\[DECLINED\]/);
  assert.equal(tr.isError, true);
  assert.equal(resumed.finalText, "ok, skipped");
});

test("resumeAgent: mismatched toolUseId throws", async () => {
  const llm = mockProvider([response([toolUse("u1", "wt", {})], "tool_use")]);
  const hits = { count: 0 };
  const tools = [writeTool("wt", hits)];
  const first = await runAgent({
    llm,
    model: "m",
    tools,
    messages: [userMsg("x")],
    confirm: pendingConfirm,
  });
  await assert.rejects(
    () =>
      resumeAgent({
        llm,
        model: "m",
        tools,
        suspended: first.suspended!,
        resume: { toolUseId: "wrong", decision: "approve" },
      }),
    /does not match suspended/,
  );
});

test("HTTP handler: pendingStore + confirm tool → returns kind:'pending', persists state", async () => {
  const llm = mockProvider([
    response([text("write")], "end_turn"),                 // router → 'write'
    response([toolUse("u1", "wt", { id: 9 })], "tool_use"),// specialist turn 1
  ]);
  const hits = { count: 0 };
  const spec = createSpecialist({
    name: "write",
    description: "write actions",
    role: "you write things",
    tools: [writeTool("wt", hits)],
  });
  const sessions = inMemoryStore();
  const pendings = inMemoryPendingStore();
  const handler: ChatHandler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [spec],
    services: {},
    store: sessions,
    pendingStore: pendings,
  });

  const out = await handler({ sessionId: "s1", message: "delete 9" });
  assert.equal(out.kind, "pending");
  if (out.kind !== "pending") return;
  assert.equal(out.routedTo, "write");
  assert.equal(out.toolUseId, "u1");
  assert.equal(out.summary, 'do wt({"id":9})');
  assert.equal(hits.count, 0);

  const stored = await pendings.get("s1");
  assert.ok(stored);
  assert.equal(stored.routedTo, "write");
  assert.equal(stored.suspended.pending.toolUseId, "u1");

  // user message persisted, no assistant message yet (still pending)
  const hist = await sessions.get("s1");
  assert.deepEqual(
    hist.map((m) => m.role),
    ["user"],
  );
});

test("HTTP handler: resume with approve → runs handler, clears pending, returns reply", async () => {
  const llm = mockProvider([
    response([text("write")], "end_turn"),
    response([toolUse("u1", "wt", { id: 9 })], "tool_use"),
    response([text("deleted")], "end_turn"),
  ]);
  const hits = { count: 0 };
  const spec = createSpecialist({
    name: "write",
    description: "",
    role: "writer",
    tools: [writeTool("wt", hits)],
  });
  const sessions = inMemoryStore();
  const pendings = inMemoryPendingStore();
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [spec],
    services: {},
    store: sessions,
    pendingStore: pendings,
  });

  await handler({ sessionId: "s1", message: "delete 9" });
  const out = await handler({ sessionId: "s1", confirm: { decision: "approve" } });
  assert.equal(out.kind, "reply");
  if (out.kind !== "reply") return;
  assert.equal(out.reply, "deleted");
  assert.equal(out.routedTo, "write");
  assert.equal(hits.count, 1);
  assert.equal(await pendings.get("s1"), undefined);

  const hist = await sessions.get("s1");
  assert.deepEqual(
    hist.map((m) => m.role),
    ["user", "assistant"],
  );
});

test("HTTP handler: resume with decline → no handler call, model gets DECLINED, reply returned", async () => {
  const llm = mockProvider([
    response([text("write")], "end_turn"),
    response([toolUse("u1", "wt", { id: 9 })], "tool_use"),
    response([text("ack, skipped")], "end_turn"),
  ]);
  const hits = { count: 0 };
  const spec = createSpecialist({
    name: "write",
    description: "",
    role: "writer",
    tools: [writeTool("wt", hits)],
  });
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [spec],
    services: {},
    store: inMemoryStore(),
    pendingStore: inMemoryPendingStore(),
  });

  await handler({ sessionId: "s1", message: "delete 9" });
  const out = await handler({ sessionId: "s1", confirm: { decision: "decline" } });
  assert.equal(out.kind, "reply");
  if (out.kind !== "reply") return;
  assert.equal(out.reply, "ack, skipped");
  assert.equal(hits.count, 0);
});

test("HTTP handler: pending exists, no decision → returns same pending again", async () => {
  const llm = mockProvider([
    response([text("write")], "end_turn"),
    response([toolUse("u1", "wt", { id: 9 })], "tool_use"),
  ]);
  const hits = { count: 0 };
  const spec = createSpecialist({
    name: "write",
    description: "",
    role: "writer",
    tools: [writeTool("wt", hits)],
  });
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [spec],
    services: {},
    store: inMemoryStore(),
    pendingStore: inMemoryPendingStore(),
  });

  const first = await handler({ sessionId: "s1", message: "delete 9" });
  // No new message, no decision — handler should re-surface the same pending without re-calling LLM.
  const callsBefore = llm.calls.length;
  const second = await handler({ sessionId: "s1" });
  assert.equal(second.kind, "pending");
  assert.equal(llm.calls.length, callsBefore, "no LLM call on re-surface");
  if (first.kind === "pending" && second.kind === "pending") {
    assert.equal(second.toolUseId, first.toolUseId);
  }
});

test("HTTP handler: no pendingStore + confirm tool → existing 'no confirm handler' error path", async () => {
  const llm = mockProvider([
    response([text("write")], "end_turn"),
    response([toolUse("u1", "wt", {})], "tool_use"),
    response([text("recovered")], "end_turn"),
  ]);
  const hits = { count: 0 };
  const spec = createSpecialist({
    name: "write",
    description: "",
    role: "writer",
    tools: [writeTool("wt", hits)],
  });
  const handler = createChatHandler({
    llm,
    routerModel: "r",
    specialistModel: "s",
    specialists: [spec],
    services: {},
    store: inMemoryStore(),
    // no pendingStore, no confirm
  });
  const out = await handler({ sessionId: "s1", message: "go" });
  assert.equal(out.kind, "reply");
  assert.equal(hits.count, 0, "handler should not have run without confirm");
});
