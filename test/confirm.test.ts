import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  runAgent,
  streamAgent,
  type AgentEvent,
  type ConfirmCallback,
  type ConfirmRequest,
  type ToolDef,
} from "../src/index.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

function recordingConfirm(answers: boolean[]): ConfirmCallback & { calls: ConfirmRequest[] } {
  const calls: ConfirmRequest[] = [];
  let i = 0;
  const fn = (async (req: ConfirmRequest) => {
    calls.push(req);
    const ans = answers[i] ?? answers[answers.length - 1];
    i++;
    return ans;
  }) as ConfirmCallback & { calls: ConfirmRequest[] };
  fn.calls = calls;
  return fn;
}

const noopWriteTool = (name: string, ran: { value: boolean }): ToolDef => ({
  name,
  description: "",
  inputSchema: {},
  requiresConfirmation: true,
  summarize: (input) => `do ${name} with ${JSON.stringify(input)}`,
  handler: async () => {
    ran.value = true;
    return "ok";
  },
});

test("confirm approves → handler runs, tool_result not error", async () => {
  const ran = { value: false };
  const llm = mockProvider([
    response([toolUse("u1", "delete", { path: "f" })], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const confirm = recordingConfirm([true]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("delete", ran)],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.equal(ran.value, true);
  assert.equal(confirm.calls.length, 1);
  assert.equal(confirm.calls[0]!.name, "delete");
  assert.equal(confirm.calls[0]!.summary, 'do delete with {"path":"f"}');
  const tr = result.messages.find((m) => m.role === "tool_result");
  assert.ok(tr && tr.role === "tool_result");
  assert.equal(tr.isError, false);
  assert.equal(tr.content, "ok");
});

test("confirm declines → [DECLINED] tool_result, handler not called", async () => {
  const ran = { value: false };
  const llm = mockProvider([
    response([toolUse("u1", "delete", { path: "f" })], "tool_use"),
    response([text("ok i wont")], "end_turn"),
  ]);
  const confirm = recordingConfirm([false]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("delete", ran)],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.equal(ran.value, false);
  const tr = result.messages.find((m) => m.role === "tool_result");
  assert.ok(tr && tr.role === "tool_result");
  assert.equal(tr.isError, true);
  assert.match(tr.content, /^\[DECLINED\] /);
  assert.match(tr.content, /do delete with/);
});

test("requiresConfirmation tool with no callback → auto-error", async () => {
  const ran = { value: false };
  const llm = mockProvider([
    response([toolUse("u1", "delete", {})], "tool_use"),
    response([text("noted")], "end_turn"),
  ]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("delete", ran)],
    messages: [userMsg("hi")],
  });
  assert.equal(ran.value, false);
  const tr = result.messages.find((m) => m.role === "tool_result");
  assert.ok(tr && tr.role === "tool_result");
  assert.equal(tr.isError, true);
  assert.match(tr.content, /no confirm handler/);
});

test("non-confirm tool ignores callback", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "echo", { x: 1 })], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const echo: ToolDef = {
    name: "echo",
    description: "",
    inputSchema: {},
    handler: async (i) => JSON.stringify(i),
  };
  const confirm = recordingConfirm([true]);
  await runAgent({
    llm,
    model: "m",
    tools: [echo],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.equal(confirm.calls.length, 0);
});

test("mixed batch: free tool runs unconditionally, confirm tool gated", async () => {
  const ranWrite = { value: false };
  const llm = mockProvider([
    response(
      [toolUse("a", "echo", { x: 1 }), toolUse("b", "delete", { path: "f" })],
      "tool_use",
    ),
    response([text("done")], "end_turn"),
  ]);
  const echo: ToolDef = {
    name: "echo",
    description: "",
    inputSchema: {},
    handler: async () => "echoed",
  };
  const confirm = recordingConfirm([false]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [echo, noopWriteTool("delete", ranWrite)],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.equal(ranWrite.value, false);
  assert.equal(confirm.calls.length, 1);
  const trs = result.messages.filter((m) => m.role === "tool_result");
  assert.equal(trs.length, 2);
  const echoTr = trs.find((t) => t.role === "tool_result" && t.toolUseId === "a");
  const delTr = trs.find((t) => t.role === "tool_result" && t.toolUseId === "b");
  assert.ok(echoTr && echoTr.role === "tool_result");
  assert.ok(delTr && delTr.role === "tool_result");
  assert.equal(echoTr.isError, false);
  assert.equal(echoTr.content, "echoed");
  assert.equal(delTr.isError, true);
  assert.match(delTr.content, /^\[DECLINED\]/);
});

test("summarize receives parsed input and propagates to callback + decline", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "delete", { path: "/a/b" })], "tool_use"),
    response([text("k")], "end_turn"),
  ]);
  let summarizeArg: unknown = null;
  const tool: ToolDef = {
    name: "delete",
    description: "",
    inputSchema: {},
    requiresConfirmation: true,
    summarize: (input) => {
      summarizeArg = input;
      return "delete /a/b";
    },
    handler: async () => "ok",
  };
  const confirm = recordingConfirm([false]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.deepEqual(summarizeArg, { path: "/a/b" });
  assert.equal(confirm.calls[0]!.summary, "delete /a/b");
  const tr = result.messages.find((m) => m.role === "tool_result");
  assert.ok(tr && tr.role === "tool_result");
  assert.match(tr.content, /delete \/a\/b/);
});

test("two confirm-required tools in one turn → callback invoked sequentially", async () => {
  const llm = mockProvider([
    response(
      [toolUse("a", "writeA", { v: 1 }), toolUse("b", "writeB", { v: 2 })],
      "tool_use",
    ),
    response([text("k")], "end_turn"),
  ]);
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const confirm: ConfirmCallback = async (req) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(`enter:${req.toolUseId}`);
    await new Promise((r) => setTimeout(r, 10));
    order.push(`exit:${req.toolUseId}`);
    inFlight--;
    return true;
  };
  const ranA = { value: false };
  const ranB = { value: false };
  await runAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("writeA", ranA), noopWriteTool("writeB", ranB)],
    messages: [userMsg("hi")],
    confirm,
  });
  assert.equal(maxInFlight, 1, "confirms must not overlap");
  assert.deepEqual(order, ["enter:a", "exit:a", "enter:b", "exit:b"]);
  assert.equal(ranA.value, true);
  assert.equal(ranB.value, true);
});

test("streaming: tool_confirm_request and tool_confirm_response emitted around await", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "delete", { path: "f" })], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const ran = { value: false };
  const events: AgentEvent[] = [];
  for await (const ev of streamAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("delete", ran)],
    messages: [userMsg("hi")],
    confirm: recordingConfirm([true]),
  })) {
    events.push(ev);
  }
  const reqIdx = events.findIndex((e) => e.type === "tool_confirm_request");
  const resIdx = events.findIndex((e) => e.type === "tool_confirm_response");
  const startIdx = events.findIndex((e) => e.type === "tool_dispatch_start");
  assert.notEqual(reqIdx, -1);
  assert.notEqual(resIdx, -1);
  assert.ok(reqIdx < resIdx, "request before response");
  assert.ok(resIdx < startIdx, "confirm response before dispatch_start");
  const req = events[reqIdx]!;
  assert.ok(req.type === "tool_confirm_request");
  assert.equal(req.toolUseId, "u1");
  assert.equal(req.summary, 'do delete with {"path":"f"}');
  const res = events[resIdx]!;
  assert.ok(res.type === "tool_confirm_response");
  assert.equal(res.confirmed, true);
});

test("streaming: declined confirm → no dispatch_start, [DECLINED] in tool_dispatch_done", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "delete", { path: "f" })], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const ran = { value: false };
  const events: AgentEvent[] = [];
  for await (const ev of streamAgent({
    llm,
    model: "m",
    tools: [noopWriteTool("delete", ran)],
    messages: [userMsg("hi")],
    confirm: recordingConfirm([false]),
  })) {
    events.push(ev);
  }
  assert.equal(ran.value, false);
  const startIdx = events.findIndex((e) => e.type === "tool_dispatch_start");
  assert.equal(startIdx, -1, "no dispatch_start for declined");
  const doneEvt = events.find((e) => e.type === "tool_dispatch_done");
  assert.ok(doneEvt && doneEvt.type === "tool_dispatch_done");
  assert.equal(doneEvt.isError, true);
  assert.match(doneEvt.content, /^\[DECLINED\]/);
});
