import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyIntent, type Intent } from "../src/index.ts";
import { mockProvider, response, text } from "./_mock.ts";

const intents: Intent[] = [
  { name: "weather", description: "weather questions" },
  { name: "math", description: "math questions" },
];

test("exact match", async () => {
  const llm = mockProvider([response([text("weather")], "end_turn")]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intent, "weather");
  assert.equal(cls.raw, "weather");
});

test("case insensitive + whitespace trimmed", async () => {
  const llm = mockProvider([response([text("  Weather\n")], "end_turn")]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intent, "weather");
});

test("substring containment fallback (e.g. 'intent: math')", async () => {
  const llm = mockProvider([response([text("intent: math.")], "end_turn")]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intent, "math");
});

test("no match → fallback", async () => {
  const llm = mockProvider([response([text("banana")], "end_turn")]);
  const cls = await classifyIntent({
    llm,
    model: "m",
    intents,
    message: "x",
    fallback: "math",
  });
  assert.equal(cls.intent, "math");
});

test("no match, no fallback → first intent", async () => {
  const llm = mockProvider([response([text("banana")], "end_turn")]);
  const cls = await classifyIntent({ llm, model: "m", intents, message: "x" });
  assert.equal(cls.intent, "weather");
});

test("history is prepended to messages sent to provider", async () => {
  const llm = mockProvider([response([text("weather")], "end_turn")]);
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
  assert.deepEqual(sent[0], { role: "user", content: "earlier" });
  assert.equal(sent[2].role, "user");
});
