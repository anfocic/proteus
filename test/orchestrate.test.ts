import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSpecialist, orchestrate, type ToolDef } from "../src/index.ts";
import { mockProvider, response, text, toolUse } from "./_mock.ts";

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

test("routes to correct specialist", async () => {
  const llm = mockProvider([
    response([text("math")], "end_turn"),
    response([text("42")], "end_turn"),
  ]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    message: "what is 6 times 7",
  });
  assert.equal(result.routedTo, "math");
  assert.equal(result.routerRaw, "math");
  assert.equal(result.finalText, "42");
});

test("router and specialist use different models", async () => {
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([text("sunny")], "end_turn"),
  ]);
  await orchestrate({
    llm,
    routerModel: "router-m",
    specialistModel: "specialist-m",
    specialists: [weather, math],
    services: {},
    message: "is it sunny",
  });
  assert.equal(llm.calls[0].model, "router-m");
  assert.equal(llm.calls[1].model, "specialist-m");
});

test("full path with tool dispatch", async () => {
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([toolUse("u1", "get_weather", { city: "Tokyo" })], "tool_use"),
    response([text("It's raining in Tokyo.")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "get_weather",
    description: "",
    inputSchema: {},
    handler: () => "rain",
  };
  const weatherWithTool = createSpecialist({
    name: "weather",
    description: "weather questions",
    role: "r",
    tools: [tool],
  });
  const result = await orchestrate({
    llm,
    routerModel: "m",
    specialistModel: "m",
    specialists: [weatherWithTool, math],
    services: {},
    message: "weather in Tokyo?",
  });
  assert.equal(result.routedTo, "weather");
  assert.equal(result.finalText, "It's raining in Tokyo.");
  assert.equal(llm.calls.length, 3);
});

test("garbage router output → falls back to first specialist", async () => {
  const llm = mockProvider([
    response([text("xyzzy")], "end_turn"),
    response([text("done")], "end_turn"),
  ]);
  const result = await orchestrate({
    llm,
    routerModel: "m",
    specialistModel: "m",
    specialists: [weather, math],
    services: {},
    message: "hi",
  });
  assert.equal(result.routedTo, "weather");
  assert.equal(result.routerRaw, "xyzzy");
});
