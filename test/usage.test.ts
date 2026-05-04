import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  addUsage,
  classifyIntent,
  createSpecialist,
  orchestrate,
  runAgent,
  runSpecialist,
  streamAgent,
  streamOrchestrate,
  zeroUsage,
} from "../src/index.ts";
import type { CompletionResponse } from "../src/llm/types.ts";
import { mockProvider, text, toolUse, userMsg } from "./_mock.ts";

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

function turn(content: CompletionResponse["content"], stopReason: CompletionResponse["stopReason"], u: { inputTokens: number; outputTokens: number }): CompletionResponse {
  return { content, stopReason, usage: u };
}

test("zeroUsage / addUsage", () => {
  assert.deepEqual(zeroUsage(), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(addUsage(usage(1, 2), usage(3, 4)), { inputTokens: 4, outputTokens: 6 });
});

test("runAgent: single turn surfaces provider usage", async () => {
  const llm = mockProvider([turn([text("hi")], "end_turn", usage(10, 5))]);
  const res = await runAgent({ llm, model: "m", tools: [], messages: [userMsg("hello")] });
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
});

test("runAgent: usage sums across tool-loop iterations", async () => {
  const llm = mockProvider([
    turn([toolUse("u1", "t", {})], "tool_use", usage(100, 20)),
    turn([text("done")], "end_turn", usage(150, 8)),
  ]);
  const res = await runAgent({
    llm,
    model: "m",
    tools: [
      {
        name: "t",
        description: "noop",
        inputSchema: { type: "object" },
        handler: () => "ok",
      },
    ],
    messages: [userMsg("go")],
  });
  assert.equal(res.iterations, 2);
  assert.deepEqual(res.usage, { inputTokens: 250, outputTokens: 28 });
});

test("runAgent: max_iterations still reports cumulative usage", async () => {
  const llm = mockProvider([
    turn([toolUse("u1", "t", {})], "tool_use", usage(5, 3)),
    turn([toolUse("u2", "t", {})], "tool_use", usage(7, 4)),
  ]);
  const res = await runAgent({
    llm,
    model: "m",
    maxIterations: 2,
    tools: [
      { name: "t", description: "", inputSchema: {}, handler: () => "ok" },
    ],
    messages: [userMsg("loop")],
  });
  assert.equal(res.stopReason, "max_iterations");
  assert.deepEqual(res.usage, { inputTokens: 12, outputTokens: 7 });
});

test("streamAgent: agent_done.result.usage equals sum of message_stop usages", async () => {
  const llm = mockProvider([
    turn([toolUse("u1", "t", {})], "tool_use", usage(40, 6)),
    turn([text("ok")], "end_turn", usage(60, 9)),
  ]);
  const events: string[] = [];
  let finalUsage = zeroUsage();
  for await (const ev of streamAgent({
    llm,
    model: "m",
    tools: [{ name: "t", description: "", inputSchema: {}, handler: () => "x" }],
    messages: [userMsg("go")],
  })) {
    events.push(ev.type);
    if (ev.type === "agent_done") finalUsage = ev.result.usage;
  }
  assert.deepEqual(finalUsage, { inputTokens: 100, outputTokens: 15 });
  assert.ok(events.includes("agent_done"));
});

test("classifyIntent: returns usage from the router LLM call", async () => {
  const llm = mockProvider([
    turn(
      [text(JSON.stringify({ intents: ["weather"], mode: "single" }))],
      "end_turn",
      usage(80, 2),
    ),
  ]);
  const cls = await classifyIntent({
    llm,
    model: "router",
    intents: [
      { name: "weather", description: "weather lookups" },
      { name: "math", description: "arithmetic" },
    ],
    message: "what's the temp",
  });
  assert.equal(cls.intents[0].name, "weather");
  assert.equal(cls.mode, "single");
  assert.deepEqual(cls.usage, { inputTokens: 80, outputTokens: 2 });
});

test("runSpecialist: usage threads through", async () => {
  const llm = mockProvider([turn([text("done")], "end_turn", usage(33, 11))]);
  const spec = createSpecialist({
    name: "s",
    description: "",
    role: "you do things",
    tools: [],
  });
  const res = await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "m",
    messages: [userMsg("hey")],
    services: {},
  });
  assert.deepEqual(res.usage, { inputTokens: 33, outputTokens: 11 });
});

test("orchestrate: routerUsage + specialistUsage + total usage", async () => {
  const llm = mockProvider([
    turn([text(JSON.stringify({ intents: ["weather"], mode: "single" }))], "end_turn", usage(50, 3)),       // router
    turn([text("sunny")], "end_turn", usage(120, 12)),       // specialist
  ]);
  const spec = createSpecialist({
    name: "weather",
    description: "weather questions",
    role: "you answer about the weather",
    tools: [],
  });
  const res = await orchestrate({
    llm,
    routerModel: "router",
    specialistModel: "main",
    specialists: [spec, createSpecialist({ name: "math", description: "math", role: "math", tools: [] })],
    services: {},
    message: "is it raining",
  });
  assert.equal(res.routedTo, "weather");
  assert.deepEqual(res.routerUsage, { inputTokens: 50, outputTokens: 3 });
  assert.deepEqual(res.specialistUsage, { inputTokens: 120, outputTokens: 12 });
  assert.deepEqual(res.usage, { inputTokens: 170, outputTokens: 15 });
});

test("streamOrchestrate: returned result has router + specialist breakdown", async () => {
  const llm = mockProvider([
    turn([text(JSON.stringify({ intents: ["math"], mode: "single" }))], "end_turn", usage(20, 1)),
    turn([text("4")], "end_turn", usage(30, 5)),
  ]);
  const specs = [
    createSpecialist({ name: "math", description: "arithmetic", role: "do math", tools: [] }),
    createSpecialist({ name: "weather", description: "weather", role: "weather", tools: [] }),
  ];
  const gen = streamOrchestrate({
    llm,
    routerModel: "r",
    specialistModel: "m",
    specialists: specs,
    services: {},
    message: "2+2",
  });
  let res;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      res = next.value;
      break;
    }
  }
  assert.equal(res.routedTo, "math");
  assert.deepEqual(res.routerUsage, { inputTokens: 20, outputTokens: 1 });
  assert.deepEqual(res.specialistUsage, { inputTokens: 30, outputTokens: 5 });
  assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 6 });
});
