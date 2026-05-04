import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createSpecialist,
  defaultParallelAggregator,
  orchestrate,
  PARALLEL_RESULT_SEPARATOR,
  type ParallelStepResult,
} from "../src/index.ts";
import { mockProvider, response, text } from "./_mock.ts";
import type { LLMProvider } from "../src/llm/provider.ts";
import type { CompletionRequest } from "../src/llm/types.ts";

const routerJSON = (intents: string[], mode: "single" | "chain" | "parallel") =>
  JSON.stringify({ intents, mode });

test("parallel: 2-way fanout joins fulfilled finalTexts with default separator", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "parallel"))], "end_turn"),
    response([text("alpha")], "end_turn"),
    response([text("beta")], "end_turn"),
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

  assert.equal(res.finalText, `alpha${PARALLEL_RESULT_SEPARATOR}beta`);
  assert.equal(res.routedTo, "a,b");
  assert.ok(res.steps);
  assert.equal(res.steps!.length, 2);
  const steps = res.steps as ParallelStepResult[];
  assert.equal(steps[0].status, "fulfilled");
  assert.equal(steps[1].status, "fulfilled");
});

test("parallel: one rejection still surfaces in steps; finalText is fulfilled-only", async () => {
  // Custom provider: router → specialist a (fulfilled) → specialist b throws
  let call = 0;
  const llm: LLMProvider & { calls: CompletionRequest[] } = {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      call++;
      if (call === 1) {
        return {
          content: [{ type: "text", text: routerJSON(["a", "b"], "parallel") }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      // Distinguish a vs b by reading the system prompt
      if (req.system?.includes("role-a")) {
        return {
          content: [{ type: "text", text: "alpha" }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      throw new Error("specialist b crashed");
    },
    async *stream() {
      throw new Error("not used");
    },
  };
  const a = createSpecialist({ name: "a", description: "a", role: "role-a", tools: [] });
  const b = createSpecialist({ name: "b", description: "b", role: "role-b", tools: [] });

  const res = await orchestrate({
    llm,
    routerModel: "rm",
    specialistModel: "sm",
    specialists: [a, b],
    services: {},
    message: "go",
  });

  assert.equal(res.finalText, "alpha");
  const steps = res.steps as ParallelStepResult[];
  assert.equal(steps.length, 2);
  const fulfilled = steps.find((s) => s.status === "fulfilled");
  const rejected = steps.find((s) => s.status === "rejected");
  assert.ok(fulfilled);
  assert.ok(rejected);
  if (rejected!.status === "rejected") {
    assert.match(rejected!.error.message, /specialist b crashed/);
  }
});

test("parallel: all reject → empty finalText, all in steps, no throw", async () => {
  let call = 0;
  const llm: LLMProvider & { calls: CompletionRequest[] } = {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      call++;
      if (call === 1) {
        return {
          content: [{ type: "text", text: routerJSON(["a", "b"], "parallel") }],
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      throw new Error("everything is broken");
    },
    async *stream() {
      throw new Error("not used");
    },
  };
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

  assert.equal(res.finalText, "");
  const steps = res.steps as ParallelStepResult[];
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => s.status === "rejected"));
});

test("parallel: custom aggregator overrides default", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "parallel"))], "end_turn"),
    response([text("alpha")], "end_turn"),
    response([text("beta")], "end_turn"),
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
    parallelAggregator: (results) =>
      `[${results
        .filter((r): r is Extract<ParallelStepResult, { status: "fulfilled" }> => r.status === "fulfilled")
        .map((r) => `${r.specialist}=${r.result.finalText}`)
        .join(";")}]`,
  });

  assert.match(res.finalText, /^\[a=alpha;b=beta\]$|^\[b=beta;a=alpha\]$/);
});

test("parallel: usage = sum across fulfilled steps + router (rejected omitted)", async () => {
  const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
  const turn = (
    content: Parameters<typeof response>[0],
    stop: Parameters<typeof response>[1],
    usage: { inputTokens: number; outputTokens: number },
  ) => ({ content, stopReason: stop, usage });
  const llm = mockProvider([
    turn([text(routerJSON(["a", "b"], "parallel"))], "end_turn", u(10, 2)),
    turn([text("alpha")], "end_turn", u(40, 5)),
    turn([text("beta")], "end_turn", u(60, 7)),
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
  assert.deepEqual(res.specialistUsage, u(100, 12));
  assert.deepEqual(res.usage, u(110, 14));
});

test("parallel: evaluate throws", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "parallel"))], "end_turn"),
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
    /'evaluate' is not supported with mode=parallel/,
  );
});

test("parallel: confirm returning 'pending' throws", async () => {
  const llm = mockProvider([
    response([text(routerJSON(["a", "b"], "parallel"))], "end_turn"),
    response(
      [{ type: "tool_use", id: "u1", name: "writer", input: {} }],
      "tool_use",
    ),
    response([text("ok")], "end_turn"),
  ]);
  const a = createSpecialist({
    name: "a",
    description: "a",
    role: "a",
    tools: [
      {
        name: "writer",
        description: "",
        inputSchema: {},
        requiresConfirmation: true,
        summarize: () => "write",
        handler: () => "wrote",
      },
    ],
  });
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
        confirm: async () => "pending",
      }),
    /'pending' confirm decision is not supported in mode=parallel/,
  );
});

test("defaultParallelAggregator skips rejected entries", () => {
  const steps: ParallelStepResult[] = [
    {
      specialist: "a",
      status: "fulfilled",
      result: {
        finalText: "alpha",
        messages: [],
        iterations: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
    {
      specialist: "b",
      status: "rejected",
      error: new Error("oops"),
    },
    {
      specialist: "c",
      status: "fulfilled",
      result: {
        finalText: "gamma",
        messages: [],
        iterations: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
  ];
  assert.equal(defaultParallelAggregator(steps), `alpha${PARALLEL_RESULT_SEPARATOR}gamma`);
});
