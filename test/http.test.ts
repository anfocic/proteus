import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createChatHandler,
  createSpecialist,
  inMemoryStore,
} from "../src/index.ts";
import { mockProvider, response, text } from "./_mock.ts";

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

test("handler routes and returns reply", async () => {
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([text("sunny")], "end_turn"),
  ]);
  const handler = createChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });
  const out = await handler({ sessionId: "s1", message: "weather?" });
  assert.equal(out.routedTo, "weather");
  assert.equal(out.reply, "sunny");
});

test("history threads across calls within a session", async () => {
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([text("first")], "end_turn"),
    response([text("weather")], "end_turn"),
    response([text("second")], "end_turn"),
  ]);
  const handler = createChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });
  await handler({ sessionId: "s1", message: "one" });
  await handler({ sessionId: "s1", message: "two" });

  // Calls 0,1 = router+specialist for turn 1. Calls 2,3 = router+specialist for turn 2.
  // Both turn-2 calls must see the prior user/assistant pair as history.
  const routerTurn2 = llm.calls[2].messages;
  assert.equal(routerTurn2.length, 3); // [prev user, prev assistant, new user]
  assert.deepEqual(routerTurn2[0], { role: "user", content: "one" });
  assert.equal(routerTurn2[1].role, "assistant");
  assert.deepEqual(routerTurn2[2], { role: "user", content: "two" });
});

test("sessions are isolated", async () => {
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response([text("A1")], "end_turn"),
    response([text("weather")], "end_turn"),
    response([text("B1")], "end_turn"),
  ]);
  const handler = createChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather, math],
    services: {},
    store: inMemoryStore(),
  });
  const a = await handler({ sessionId: "alice", message: "hi from alice" });
  const b = await handler({ sessionId: "bob", message: "hi from bob" });
  assert.equal(a.reply, "A1");
  assert.equal(b.reply, "B1");

  // Bob's router call (call index 2) must not contain alice's history.
  const bobRouter = llm.calls[2].messages;
  assert.equal(bobRouter.length, 1);
  assert.deepEqual(bobRouter[0], { role: "user", content: "hi from bob" });
});

test("tool transcripts are NOT persisted to history (only safe pair)", async () => {
  // Specialist invokes a tool — full path is router → tool_use → tool_result → text.
  const tool = {
    name: "echo",
    description: "",
    inputSchema: {},
    handler: () => "x",
  };
  const weatherWithTool = createSpecialist({
    name: "weather",
    description: "weather questions",
    role: "r",
    tools: [tool],
  });
  const llm = mockProvider([
    response([text("weather")], "end_turn"),
    response(
      [{ type: "tool_use", id: "u1", name: "echo", input: {} }],
      "tool_use",
    ),
    response([text("final")], "end_turn"),
    // turn 2:
    response([text("weather")], "end_turn"),
    response([text("ok")], "end_turn"),
  ]);
  const store = inMemoryStore();
  const handler = createChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weatherWithTool, math],
    services: {},
    store,
  });
  await handler({ sessionId: "s", message: "first" });
  const persisted = await store.get("s");
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].role, "user");
  assert.equal(persisted[1].role, "assistant");
  // assistant message must be plain text, no tool_use blocks
  const assistantContent = persisted[1].role === "assistant" ? persisted[1].content : [];
  assert.equal(assistantContent.length, 1);
  assert.equal(assistantContent[0].type, "text");
});
