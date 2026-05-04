import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createChatHandler,
  createSpecialist,
  inMemoryStore,
  orchestrate,
  streamOrchestrate,
  type EvaluatorFn,
  type EvaluatorVerdict,
  type Message,
} from "../src/index.ts";
import type {
  CompletionResponse,
  ContentBlock,
  StopReason,
  Usage,
} from "../src/llm/types.ts";
import { mockProvider, text } from "./_mock.ts";

function res(content: ContentBlock[], stopReason: StopReason, usage: Usage): CompletionResponse {
  return { content, stopReason, usage };
}

const weather = createSpecialist({
  name: "weather",
  description: "weather questions",
  role: "weather agent",
  tools: [],
});

function scriptedEvaluator(verdicts: EvaluatorVerdict[]): EvaluatorFn & { calls: number } {
  let i = 0;
  const fn = (async () => {
    const v = verdicts[i] ?? verdicts[verdicts.length - 1]!;
    i++;
    (fn as unknown as { calls: number }).calls = i;
    return v;
  }) as unknown as EvaluatorFn & { calls: number };
  fn.calls = 0;
  return fn;
}

test("evaluator: first-pass ok → no retry, attempts=1", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("sunny")], "end_turn", { inputTokens: 10, outputTokens: 5 }),
  ]);
  const evaluate = scriptedEvaluator([{ ok: true }]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "is it sunny",
    evaluate,
  });
  assert.equal(evaluate.calls, 1);
  assert.equal(result.evaluatorAttempts, 1);
  assert.equal(result.finalText, "sunny");
  // 2 LLM calls total: router + specialist (no retry)
  assert.equal(llm.calls.length, 2);
  // No injected feedback message
  const userMsgs = result.messages.filter((m: Message) => m.role === "user");
  assert.equal(userMsgs.length, 1);
});

test("evaluator: retry-then-ok → 2 specialist calls, feedback injected, usage summed", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 1, outputTokens: 1 }),
    res([text("hot")], "end_turn", { inputTokens: 10, outputTokens: 5 }),
    res([text("It is 25 degrees and sunny.")], "end_turn", { inputTokens: 12, outputTokens: 8 }),
  ]);
  const evaluate = scriptedEvaluator([
    { ok: false, feedback: "be more specific", usage: { inputTokens: 3, outputTokens: 1 } },
    { ok: true, usage: { inputTokens: 3, outputTokens: 1 } },
  ]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "weather",
    evaluate,
  });
  assert.equal(evaluate.calls, 2);
  assert.equal(result.evaluatorAttempts, 2);
  // 3 LLM calls: router + specialist x 2
  assert.equal(llm.calls.length, 3);
  // Second specialist call must have received the feedback as a user message.
  // (mockProvider records a reference to messages which the agent loop mutates,
  // so we look for the feedback by content rather than rely on positional order.)
  const secondCallMsgs = llm.calls[2]!.messages;
  const feedbackMsg = secondCallMsgs.find(
    (m) => m.role === "user" && String(m.content) === "be more specific",
  );
  assert.ok(feedbackMsg, "feedback user message must be in second specialist call input");
  // specialistUsage = sum of two specialist runs (15 + 20 in/out wise, but we sum components).
  assert.deepEqual(result.specialistUsage, { inputTokens: 22, outputTokens: 13 });
  assert.deepEqual(result.evaluatorUsage, { inputTokens: 6, outputTokens: 2 });
  // total usage = router + specialist + evaluator
  assert.deepEqual(result.usage, { inputTokens: 1 + 22 + 6, outputTokens: 1 + 13 + 2 });
  assert.equal(result.finalText, "It is 25 degrees and sunny.");
});

test("evaluator: cap hit → returns last result, attempts=max, no throw", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("v1")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("v2")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate = scriptedEvaluator([{ ok: false }, { ok: false }, { ok: false }]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "go",
    evaluate,
    maxEvaluatorAttempts: 2,
  });
  assert.equal(result.evaluatorAttempts, 2);
  assert.equal(result.finalText, "v2");
  // Evaluator called for each attempt (2). Not for a 3rd attempt that wouldn't run.
  assert.equal(evaluate.calls, 2);
  assert.equal(llm.calls.length, 3); // router + 2 specialist
});

test("evaluator: maxEvaluatorAttempts=1 → no retry even on ok:false", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("only attempt")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate = scriptedEvaluator([{ ok: false, feedback: "ignored" }]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "go",
    evaluate,
    maxEvaluatorAttempts: 1,
  });
  assert.equal(result.evaluatorAttempts, 1);
  assert.equal(evaluate.calls, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(result.finalText, "only attempt");
});

test("evaluator: not set → attempts=1, evaluatorUsage zero, no behaviour change", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("sunny")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const result = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "go",
  });
  assert.equal(result.evaluatorAttempts, 1);
  assert.deepEqual(result.evaluatorUsage, { inputTokens: 0, outputTokens: 0 });
});

test("evaluator: default feedback when verdict.feedback is undefined", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("v1")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("v2")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate = scriptedEvaluator([{ ok: false }, { ok: true }]);
  await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "go",
    evaluate,
  });
  const secondMsgs = llm.calls[2]!.messages;
  const fb = secondMsgs.find(
    (m) => m.role === "user" && /Please reconsider/.test(String(m.content)),
  );
  assert.ok(fb, "default feedback user message must be in second specialist call input");
});

test("evaluator: throws → bubbles up", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("ans")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate: EvaluatorFn = async () => {
    throw new Error("evaluator boom");
  };
  await assert.rejects(
    orchestrate({
      llm,
      routerModel: "rm",
      specialistModel: "sm",
      specialists: [weather],
      services: {},
      message: "go",
      evaluate,
    }),
    /evaluator boom/,
  );
});

test("streamOrchestrate: rejects when evaluate is set", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("ans")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate: EvaluatorFn = async () => ({ ok: true });
  const gen = streamOrchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    message: "go",
    evaluate,
  });
  await assert.rejects(gen.next(), /not support 'evaluate'/);
});

test("createChatHandler: threads evaluate → reply reflects retried answer", async () => {
  const llm = mockProvider([
    res([text("weather")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("draft")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
    res([text("better")], "end_turn", { inputTokens: 0, outputTokens: 0 }),
  ]);
  const evaluate = scriptedEvaluator([{ ok: false, feedback: "improve" }, { ok: true }]);
  const handler = createChatHandler({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [weather],
    services: {},
    store: inMemoryStore(),
    evaluate,
  });
  const reply = await handler({ sessionId: "s1", message: "hi" });
  assert.equal(reply.kind, "reply");
  if (reply.kind !== "reply") return;
  assert.equal(reply.reply, "better");
  assert.equal(evaluate.calls, 2);
});
