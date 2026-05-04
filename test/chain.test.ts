import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ChainDispatchError,
  createSpecialist,
  orchestrate,
} from "../src/index.ts";
import { mockProvider, response, text } from "./_mock.ts";

const routerJSON = (intents: string[], mode: "single" | "chain" | "parallel") =>
  JSON.stringify({ intents, mode });

test("chain: 2-step chain wraps prior output in <previous_step_output>", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["lookup", "summarize"], "chain"))], "end_turn"),
    response([text("found Alice in Berlin")], "end_turn"),
    response([text("Alice lives in Berlin.")], "end_turn"),
  ]);
  const lookup = createSpecialist({
    name: "lookup",
    description: "find people",
    role: "you find people",
    tools: [],
  });
  const summarize = createSpecialist({
    name: "summarize",
    description: "summarize results",
    role: "you summarize",
    tools: [],
  });

  const res = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [lookup, summarize],
    services: {},
    message: "where does Alice live",
  });

  assert.equal(res.routedTo, "summarize");
  assert.equal(res.finalText, "Alice lives in Berlin.");
  assert.ok(res.steps);
  assert.equal(res.steps!.length, 2);
  assert.equal(res.steps![0].specialist, "lookup");
  assert.equal(res.steps![1].specialist, "summarize");

  // Second specialist's user message should embed the first step's output.
  const secondCall = llm.calls[2];
  const userMsg = secondCall.messages.find((m) => m.role === "user");
  assert.ok(userMsg);
  assert.match(userMsg!.content as string, /<previous_step_output>found Alice in Berlin<\/previous_step_output>/);
});

test("chain: prior output truncated to chainContextChars", async () => {
  const long = "x".repeat(5000);
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "chain"))], "end_turn"),
    response([text(long)], "end_turn"),
    response([text("done")], "end_turn"),
  ]);
  const a = createSpecialist({ name: "a", description: "a", role: "a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "b", tools: [] });

  await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [a, b],
    services: {},
    message: "go",
    chainContextChars: 50,
  });

  const secondCall = llm.calls[2];
  const userMsg = secondCall.messages.find((m) => m.role === "user");
  assert.ok(userMsg);
  const userText = userMsg!.content as string;
  // Embedded section should contain exactly 50 x's, not the full 5000.
  const match = userText.match(/<previous_step_output>(x+)<\/previous_step_output>/);
  assert.ok(match);
  assert.equal(match![1].length, 50);
});

test("chain: custom formatter overrides default", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "chain"))], "end_turn"),
    response([text("hello")], "end_turn"),
    response([text("done")], "end_turn"),
  ]);
  const a = createSpecialist({ name: "a", description: "a", role: "a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "b", tools: [] });

  await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [a, b],
    services: {},
    message: "go",
    chainContextFormatter: (prior, original) =>
      prior ? `CUSTOM[${prior.result.finalText}] ${original}` : original,
  });

  const secondCall = llm.calls[2];
  const userMsg = secondCall.messages.find((m) => m.role === "user");
  assert.ok(userMsg);
  assert.equal(userMsg!.content, "CUSTOM[hello] go");
});

test("chain: step LLM call throws → ChainDispatchError carries completed steps", async () => {
  // Step a returns normally; step b's LLM call rejects. Chain dispatch
  // wraps the rejection in ChainDispatchError with steps[0] populated.
  let call = 0;
  const llm: import("../src/llm/provider.ts").LLMProvider & {
    calls: import("../src/llm/types.ts").CompletionRequest[];
  } = {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      call++;
      if (call === 1) {
        return {
          content: [{ type: "text", text: routerJSON(["a", "b"], "chain") }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      if (call === 2) {
        return {
          content: [{ type: "text", text: "step a done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      throw new Error("network down");
    },
    async *stream() {
      throw new Error("not used");
    },
  };

  const a = createSpecialist({ name: "a", description: "a", role: "a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "b", tools: [] });

  await assert.rejects(
    () =>
      orchestrate({
        llm,
        routerModel: "rm",
        specialistModel: "sm",
        specialists: [a, b],
        services: {},
        message: "go",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ChainDispatchError);
      const e = err as ChainDispatchError;
      assert.equal(e.failedAt, "b");
      assert.equal(e.steps.length, 1);
      assert.equal(e.steps[0].specialist, "a");
      return true;
    },
  );
});

test("chain: usage = router + sum across steps", async () => {
  const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
  const turn = (
    content: Parameters<typeof response>[0],
    stop: Parameters<typeof response>[1],
    usage: { inputTokens: number; outputTokens: number },
  ) => ({ content, stopReason: stop, usage });
  const llm = mockProvider([
    turn([text(routerJSON(["a", "b"], "chain"))], "end_turn", u(10, 2)),
    turn([text("hello")], "end_turn", u(50, 5)),
    turn([text("done")], "end_turn", u(80, 8)),
  ]);
  const a = createSpecialist({ name: "a", description: "a", role: "a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "b", tools: [] });

  const res = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [a, b],
    services: {},
    message: "go",
  });

  assert.deepEqual(res.routerUsage, u(10, 2));
  assert.deepEqual(res.specialistUsage, u(130, 13));
  assert.deepEqual(res.usage, u(140, 15));
});

test("chain: evaluate throws with mode=chain", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "chain"))], "end_turn"),
  ]);
  const a = createSpecialist({ name: "a", description: "a", role: "a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "b", tools: [] });
  await assert.rejects(
    () =>
      orchestrate({
        llm,
        routerModel: "rm",
        specialistModel: "sm",
        specialists: [a, b],
        services: {},
        message: "go",
        evaluate: async () => ({ ok: true }),
      }),
    /'evaluate' is not supported with mode=chain/,
  );
});
