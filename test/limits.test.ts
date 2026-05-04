import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  resumeAgent,
  runAgent,
  streamAgent,
  type AgentEvent,
  type ConfirmCallback,
  type ToolDef,
} from "../src/index.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

function findToolResult(messages: { role: string }[]) {
  const tr = messages.find((m) => m.role === "tool_result") as
    | { role: "tool_result"; content: string; isError: boolean; toolUseId: string }
    | undefined;
  assert.ok(tr, "expected a tool_result message");
  return tr;
}

test("timeout fires → [TIMEOUT] marker, isError true", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    timeoutMs: 10,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "should not reach";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, true);
  assert.equal(tr.content, "[TIMEOUT] Tool exceeded 10ms");
});

test("handler under timeoutMs → no marker", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "fast", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "fast",
    description: "",
    inputSchema: {},
    timeoutMs: 100,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "fine";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.equal(tr.content, "fine");
});

test("no timeoutMs set → handler runs to completion regardless of duration", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    handler: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "done";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.content, "done");
  assert.equal(tr.isError, false);
});

test("truncation over cap → marker appended, prefix preserved", async () => {
  const big = "x".repeat(1000);
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    maxResultBytes: 100,
    handler: async () => big,
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.ok(tr.content.startsWith("x".repeat(100)));
  assert.ok(tr.content.endsWith("[TRUNCATED: 100 of 1000 bytes]"));
});

test("under cap unchanged", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    maxResultBytes: 100,
    handler: async () => "tiny",
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.content, "tiny");
});

test("timeout + truncation combined: passes within timeout, truncated", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    timeoutMs: 200,
    maxResultBytes: 50,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "y".repeat(500);
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.ok(!tr.content.startsWith("[TIMEOUT]"));
  assert.ok(tr.content.endsWith("[TRUNCATED: 50 of 500 bytes]"));
});

test("streamAgent path: timeout marker reaches tool_dispatch_done", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    timeoutMs: 10,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "nope";
    },
  };
  const events: AgentEvent[] = [];
  for await (const ev of streamAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "tool_dispatch_done");
  assert.ok(done && done.type === "tool_dispatch_done");
  assert.equal(done.isError, true);
  assert.equal(done.content, "[TIMEOUT] Tool exceeded 10ms");
});

test("resumeAgent path: maxResultBytes applied on approve", async () => {
  const big = "z".repeat(400);
  const llm = mockProvider([
    response([toolUse("u1", "wt", {})], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "wt",
    description: "",
    inputSchema: {},
    requiresConfirmation: true,
    summarize: () => "wt",
    maxResultBytes: 32,
    handler: async () => big,
  };
  const pendingConfirm: ConfirmCallback = async () => "pending";
  const first = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("go")],
    confirm: pendingConfirm,
  });
  assert.ok(first.suspended);
  const resumed = await resumeAgent({
    llm,
    model: "m",
    tools: [tool],
    suspended: first.suspended,
    resume: { toolUseId: "u1", decision: "approve" },
  });
  const tr = findToolResult(resumed.messages);
  assert.ok(tr.content.startsWith("z".repeat(32)));
  assert.ok(tr.content.endsWith("[TRUNCATED: 32 of 400 bytes]"));
});

test("multibyte boundary: emoji split does not throw", async () => {
  // Emoji is 4 UTF-8 bytes. Cap at 5 mid-second-emoji should not crash.
  const llm = mockProvider([
    response([toolUse("u1", "emoji", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "emoji",
    description: "",
    inputSchema: {},
    maxResultBytes: 5,
    handler: async () => "🦊🦊🦊", // 12 bytes total
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.ok(tr.content.includes("[TRUNCATED: 5 of 12 bytes]"));
  // Must be valid JS string (no thrown decode error reaching here is the assertion).
});
