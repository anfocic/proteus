import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyIntent, type Intent } from "../src/index.ts";
import { mockProvider, response, text } from "./_mock.ts";

const intents: Intent[] = [
  { name: "weather", description: "weather questions" },
  { name: "math", description: "math questions" },
  { name: "calendar", description: "calendar lookups" },
];

const json = (v: unknown) => JSON.stringify(v);

test("single intent JSON → intents=[x], mode=single", async () => {
  const llm = mockProvider([
    response([text(json({ intents: ["math"], mode: "single", reasoning: "math q" }))], "end_turn"),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intents.length, 1);
  assert.equal(cls.intents[0].name, "math");
  assert.equal(cls.mode, "single");
  assert.equal(cls.reasoning, "math q");
});

test("multi-intent JSON with mode=parallel preserves order + mode", async () => {
  const llm = mockProvider([
    response(
      [text(json({ intents: ["weather", "calendar"], mode: "parallel", reasoning: "two queries" }))],
      "end_turn",
    ),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.mode, "parallel");
  assert.deepEqual(
    cls.intents.map((i) => i.name),
    ["weather", "calendar"],
  );
});

test("mode=chain preserves order", async () => {
  const llm = mockProvider([
    response([text(json({ intents: ["calendar", "weather"], mode: "chain" }))], "end_turn"),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.mode, "chain");
  assert.deepEqual(
    cls.intents.map((i) => i.name),
    ["calendar", "weather"],
  );
});

test("falls back to reasoning block when text empty", async () => {
  const llm = mockProvider([
    response(
      [
        { type: "reasoning", text: json({ intents: ["weather"], mode: "single" }) },
        { type: "text", text: "" },
      ],
      "end_turn",
    ),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intents[0].name, "weather");
});

test("truncated JSON repaired by lenient parser", async () => {
  const llm = mockProvider([
    response([text('{"intents": ["math"], "mode": "single"')], "end_turn"),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intents[0].name, "math");
  assert.equal(cls.mode, "single");
});

test("garbage response falls back to first registered, mode=single", async () => {
  const llm = mockProvider([response([text("not json at all")], "end_turn")]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intents[0].name, "weather");
  assert.equal(cls.mode, "single");
  assert.equal(cls.reasoning, "router parse failed");
});

test("unknown intent names dropped; if all unknown, fallback", async () => {
  const llm = mockProvider([
    response([text(json({ intents: ["foo", "bar"], mode: "single" }))], "end_turn"),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intents[0].name, "weather");
  assert.equal(cls.reasoning, "router returned no known intents");
});

test("mix of known + unknown intents keeps only known", async () => {
  const llm = mockProvider([
    response(
      [text(json({ intents: ["foo", "math", "bar", "weather"], mode: "chain" }))],
      "end_turn",
    ),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.deepEqual(cls.intents.map((i) => i.name), ["math", "weather"]);
  assert.equal(cls.mode, "chain");
});

test("maxIntents truncates to N", async () => {
  const llm = mockProvider([
    response(
      [text(json({ intents: ["weather", "math", "calendar"], mode: "parallel" }))],
      "end_turn",
    ),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x", maxIntents: 2 });
  assert.equal(cls.intents.length, 2);
  assert.deepEqual(cls.intents.map((i) => i.name), ["weather", "math"]);
});

test("invalid mode coerces to single", async () => {
  const llm = mockProvider([
    response([text(json({ intents: ["math"], mode: "magic" }))], "end_turn"),
  ]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.mode, "single");
});

test("history is prepended to messages sent to provider", async () => {
  const llm = mockProvider([
    response([text(json({ intents: ["weather"], mode: "single" }))], "end_turn"),
  ]);
  await classifyIntent({
    llm,
    model: "m",
    intents,
    message: "now",
    history: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
    ],
  });
  const sent = llm.calls[0].messages;
  assert.equal(sent.length, 3);
  assert.equal(sent[2].role, "user");
});
