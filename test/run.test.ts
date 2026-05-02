import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runAgent, type ToolDef } from "../src/index.ts";
import { deferred, mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

test("single text response → end_turn", async () => {
  const llm = mockProvider([response([text("hello")], "end_turn")]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [],
    messages: [userMsg("hi")],
  });
  assert.equal(result.iterations, 1);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.finalText, "hello");
});

test("tool call → result → final text", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "echo", { x: 1 })], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "echo",
    description: "",
    inputSchema: {},
    handler: async (input) => `got:${JSON.stringify(input)}`,
  };
  const result = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
  });
  assert.equal(result.iterations, 2);
  assert.equal(result.finalText, "done");
  const toolResult = result.messages.find((m) => m.role === "tool_result");
  assert.ok(toolResult && toolResult.role === "tool_result");
  assert.equal(toolResult.toolUseId, "u1");
  assert.equal(toolResult.content, 'got:{"x":1}');
  assert.equal(toolResult.isError, false);
});

test("parallel tool calls run concurrently", async () => {
  const llm = mockProvider([
    response(
      [toolUse("a", "first", {}), toolUse("b", "second", {})],
      "tool_use",
    ),
    response([text("ok")], "end_turn"),
  ]);

  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();

  const tools: ToolDef[] = [
    {
      name: "first",
      description: "",
      inputSchema: {},
      handler: async () => {
        firstStarted.resolve();
        await secondStarted.promise;
        return "1";
      },
    },
    {
      name: "second",
      description: "",
      inputSchema: {},
      handler: async () => {
        await firstStarted.promise;
        secondStarted.resolve();
        return "2";
      },
    },
  ];

  const result = await runAgent({
    llm,
    model: "m",
    tools,
    messages: [userMsg("hi")],
  });
  assert.equal(result.iterations, 2);
  const toolResults = result.messages.filter((m) => m.role === "tool_result");
  assert.equal(toolResults.length, 2);
});

test("tool handler that throws produces isError tool_result", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "boom", {})], "tool_use"),
    response([text("recovered")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "boom",
    description: "",
    inputSchema: {},
    handler: () => {
      throw new Error("kaboom");
    },
  };
  const result = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
  });
  const toolResult = result.messages.find((m) => m.role === "tool_result");
  assert.ok(toolResult && toolResult.role === "tool_result");
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.content, "kaboom");
  assert.equal(result.finalText, "recovered");
});

test("unknown tool produces isError tool_result", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "ghost", {})], "tool_use"),
    response([text("oops")], "end_turn"),
  ]);
  const result = await runAgent({
    llm,
    model: "m",
    tools: [],
    messages: [userMsg("hi")],
  });
  const toolResult = result.messages.find((m) => m.role === "tool_result");
  assert.ok(toolResult && toolResult.role === "tool_result");
  assert.equal(toolResult.isError, true);
  assert.equal(toolResult.content, "Unknown tool: ghost");
});

test("max_iterations exits gracefully", async () => {
  const llm = mockProvider([response([toolUse("u1", "loop", {})], "tool_use")]);
  const tool: ToolDef = {
    name: "loop",
    description: "",
    inputSchema: {},
    handler: () => "again",
  };
  const result = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
    maxIterations: 3,
  });
  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 3);
});

test("services thread through to handler ctx", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "peek", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  let seen: unknown = null;
  const tool: ToolDef<unknown, { foo: string }> = {
    name: "peek",
    description: "",
    inputSchema: {},
    handler: (_input, ctx) => {
      seen = ctx.services;
      return "ok";
    },
  };
  await runAgent<{ foo: string }>({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
    services: { foo: "bar" },
  });
  assert.deepEqual(seen, { foo: "bar" });
});
