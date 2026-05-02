import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSpecialist, runSpecialist, type ToolDef } from "../src/index.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

test("createSpecialist returns config unchanged", () => {
  const cfg = {
    name: "x",
    description: "d",
    role: "r",
    tools: [],
  };
  assert.equal(createSpecialist(cfg), cfg);
});

test("runSpecialist passes role as system", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const spec = createSpecialist({
    name: "s",
    description: "d",
    role: "you are a helper",
    tools: [],
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "default-m",
    messages: [userMsg("hi")],
    services: {},
  });
  assert.equal(llm.calls[0].system, "you are a helper");
});

test("services flow through to tool handler", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "peek", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  let seen: unknown = null;
  const tool: ToolDef<unknown, { db: string }> = {
    name: "peek",
    description: "",
    inputSchema: {},
    handler: (_i, ctx) => {
      seen = ctx.services;
      return "x";
    },
  };
  const spec = createSpecialist<{ db: string }>({
    name: "s",
    description: "d",
    role: "r",
    tools: [tool],
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "default-m",
    messages: [userMsg("hi")],
    services: { db: "live" },
  });
  assert.deepEqual(seen, { db: "live" });
});

test("specialist.model overrides defaultModel", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const spec = createSpecialist({
    name: "s",
    description: "d",
    role: "r",
    tools: [],
    model: "specialist-m",
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "default-m",
    messages: [userMsg("hi")],
    services: {},
  });
  assert.equal(llm.calls[0].model, "specialist-m");
});

test("defaultModel used when specialist.model unset", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const spec = createSpecialist({
    name: "s",
    description: "d",
    role: "r",
    tools: [],
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "default-m",
    messages: [userMsg("hi")],
    services: {},
  });
  assert.equal(llm.calls[0].model, "default-m");
});
