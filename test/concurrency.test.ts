import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runAgent, type ToolDef } from "../src/index.ts";
import { mapLimit } from "../src/agent/concurrency.ts";
import { mockProvider, response, toolUse, text, userMsg } from "./_mock.ts";

test("mapLimit: undefined limit → all parallel (Promise.all behavior)", async () => {
  let inflight = 0;
  let peak = 0;
  const fn = async (n: number) => {
    inflight++;
    if (inflight > peak) peak = inflight;
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return n * 2;
  };
  const r = await mapLimit([1, 2, 3, 4, 5], undefined, fn);
  assert.deepEqual(r, [2, 4, 6, 8, 10]);
  assert.equal(peak, 5);
});

test("mapLimit: cap=2 caps inflight count", async () => {
  let inflight = 0;
  let peak = 0;
  const fn = async (n: number) => {
    inflight++;
    if (inflight > peak) peak = inflight;
    await new Promise((r) => setTimeout(r, 10));
    inflight--;
    return n;
  };
  await mapLimit([1, 2, 3, 4, 5, 6], 2, fn);
  assert.equal(peak, 2);
});

test("mapLimit: preserves input order even when individual durations vary", async () => {
  const r = await mapLimit([100, 5, 50, 1, 30], 2, (n) =>
    new Promise<number>((res) => setTimeout(() => res(n), n)),
  );
  assert.deepEqual(r, [100, 5, 50, 1, 30]);
});

test("mapLimit: cap >= items → all parallel", async () => {
  let peak = 0;
  let inflight = 0;
  const fn = async (n: number) => {
    inflight++;
    if (inflight > peak) peak = inflight;
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return n;
  };
  await mapLimit([1, 2, 3], 10, fn);
  assert.equal(peak, 3);
});

test("runAgent: toolConcurrency=2 caps handler execution; result order preserved", async () => {
  const llm = mockProvider([
    response(
      [
        toolUse("u1", "slow", { id: 1 }),
        toolUse("u2", "slow", { id: 2 }),
        toolUse("u3", "slow", { id: 3 }),
        toolUse("u4", "slow", { id: 4 }),
      ],
      "tool_use",
    ),
    response([text("done")], "end_turn"),
  ]);
  let inflight = 0;
  let peak = 0;
  const slow: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    handler: async (input) => {
      inflight++;
      if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, 15));
      inflight--;
      return `result-${(input as { id: number }).id}`;
    },
  };
  const res = await runAgent({
    llm,
    model: "m",
    tools: [slow],
    messages: [userMsg("go")],
    toolConcurrency: 2,
  });

  assert.equal(peak, 2);
  // tool_results appear in tool_use order
  const trs = res.messages.filter((m) => m.role === "tool_result");
  assert.equal(trs.length, 4);
  assert.deepEqual(
    trs.map((m) => (m as { toolUseId: string }).toolUseId),
    ["u1", "u2", "u3", "u4"],
  );
  assert.deepEqual(
    trs.map((m) => (m as { content: string }).content),
    ["result-1", "result-2", "result-3", "result-4"],
  );
});

test("runAgent: toolConcurrency unset → unbounded (all parallel)", async () => {
  const llm = mockProvider([
    response(
      [toolUse("u1", "s", {}), toolUse("u2", "s", {}), toolUse("u3", "s", {})],
      "tool_use",
    ),
    response([text("ok")], "end_turn"),
  ]);
  let inflight = 0;
  let peak = 0;
  const s: ToolDef = {
    name: "s",
    description: "",
    inputSchema: {},
    handler: async () => {
      inflight++;
      if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return "x";
    },
  };
  await runAgent({ llm, model: "m", tools: [s], messages: [userMsg("go")] });
  assert.equal(peak, 3);
});
