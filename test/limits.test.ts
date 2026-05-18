import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  resumeAgent,
  runAgent,
  streamAgent,
  type AgentEvent,
  type ConfirmCallback,
  type ToolContext,
  type ToolDef,
} from "../src/index.ts";
import { mockProvider, response, text, toolUse, userMsg } from "./_mock.ts";

function findToolResult(messages: { role: string }[]) {
  const tr = messages.find((m) => m.role === "tool_result") as
    | { role: "tool_result"; content: string; isError: boolean; toolUseId: string }
    | undefined;
  assert.ok(tr, "expected a tool_result message");
  return tr;
}

test("timeout fires → [TIMEOUT] marker, isError true", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    timeoutMs: 10,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "should not reach";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, true);
  assert.equal(tr.content, "[TIMEOUT] Tool exceeded 10ms");
});

test("handler under timeoutMs → no marker", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "fast", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "fast",
    description: "",
    inputSchema: {},
    timeoutMs: 100,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "fine";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.equal(tr.content, "fine");
});

test("no timeoutMs set → handler runs to completion regardless of duration", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    handler: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "done";
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.content, "done");
  assert.equal(tr.isError, false);
});

test("truncation over cap → marker appended, prefix preserved", async () => {
  const big = "x".repeat(1000);
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    maxResultBytes: 100,
    handler: async () => big,
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.ok(tr.content.startsWith("x".repeat(100)));
  assert.ok(tr.content.endsWith("[TRUNCATED: 100 of 1000 bytes]"));
});

test("under cap unchanged", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    maxResultBytes: 100,
    handler: async () => "tiny",
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.content, "tiny");
});

test("timeout + truncation combined: passes within timeout, truncated", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "blob", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "blob",
    description: "",
    inputSchema: {},
    timeoutMs: 200,
    maxResultBytes: 50,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "y".repeat(500);
    },
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.equal(tr.isError, false);
  assert.ok(!tr.content.startsWith("[TIMEOUT]"));
  assert.ok(tr.content.endsWith("[TRUNCATED: 50 of 500 bytes]"));
});

test("streamAgent path: timeout marker reaches tool_dispatch_done", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    timeoutMs: 10,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return "nope";
    },
  };
  const events: AgentEvent[] = [];
  for await (const ev of streamAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.type === "tool_dispatch_done");
  assert.ok(done && done.type === "tool_dispatch_done");
  assert.equal(done.isError, true);
  assert.equal(done.content, "[TIMEOUT] Tool exceeded 10ms");
});

test("resumeAgent path: maxResultBytes applied on approve", async () => {
  const big = "z".repeat(400);
  const llm = mockProvider([
    response([toolUse("u1", "wt", {})], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "wt",
    description: "",
    inputSchema: {},
    requiresConfirmation: true,
    summarize: () => "wt",
    maxResultBytes: 32,
    handler: async () => big,
  };
  const pendingConfirm: ConfirmCallback = async () => "pending";
  const first = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("go")],
    confirm: pendingConfirm,
  });
  assert.ok(first.suspended);
  const resumed = await resumeAgent({
    llm,
    model: "m",
    tools: [tool],
    suspended: first.suspended,
    resume: { toolUseId: "u1", decision: "approve" },
  });
  const tr = findToolResult(resumed.messages);
  assert.ok(tr.content.startsWith("z".repeat(32)));
  assert.ok(tr.content.endsWith("[TRUNCATED: 32 of 400 bytes]"));
});

test("multibyte boundary: emoji split does not throw", async () => {
  // Emoji is 4 UTF-8 bytes. Cap at 5 mid-second-emoji should not crash.
  const llm = mockProvider([
    response([toolUse("u1", "emoji", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const tool: ToolDef = {
    name: "emoji",
    description: "",
    inputSchema: {},
    maxResultBytes: 5,
    handler: async () => "🦊🦊🦊", // 12 bytes total
  };
  const result = await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const tr = findToolResult(result.messages);
  assert.ok(tr.content.includes("[TRUNCATED: 5 of 12 bytes]"));
  // Must be valid JS string (no thrown decode error reaching here is the assertion).
});

// --- ctx.signal --------------------------------------------------------------

test("ctx.signal: present and not-aborted at handler entry with no input signal and no timeoutMs", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "probe", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  let observed: AbortSignal | undefined;
  const tool: ToolDef = {
    name: "probe",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      observed = ctx.signal;
      return "k";
    },
  };
  await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  assert.ok(observed instanceof AbortSignal, "ctx.signal must be an AbortSignal");
  assert.equal(observed!.aborted, false);
});

test("ctx.signal: fires when agent-level signal is aborted mid-handler", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "wait", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const ctl = new AbortController();
  let abortedInHandler = false;
  const tool: ToolDef = {
    name: "wait",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          abortedInHandler = ctx.signal.aborted;
          resolve();
        });
        setTimeout(() => ctl.abort(), 5);
      });
      return "observed";
    },
  };
  // After the handler observes the abort and returns, the next loop iteration
  // tries llm.complete with the aborted signal and throws AbortError. That's
  // the correct propagation contract — assert the handler observed it first.
  await assert.rejects(
    runAgent({
      llm,
      model: "m",
      tools: [tool],
      messages: [userMsg("hi")],
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(abortedInHandler, true);
});

test("ctx.signal: fires on timeoutMs expiry AND framework still returns [TIMEOUT]", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "slow", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  let aborted = false;
  const tool: ToolDef = {
    name: "slow",
    description: "",
    inputSchema: {},
    timeoutMs: 10,
    handler: async (_input, ctx: ToolContext) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      return "never";
    },
  };
  const result = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("hi")],
  });
  // Outer contract preserved.
  const tr = findToolResult(result.messages);
  assert.equal(tr.content, "[TIMEOUT] Tool exceeded 10ms");
  assert.equal(tr.isError, true);
  // Give the still-running handler a moment to observe the abort.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aborted, true, "ctx.signal should have fired when timeoutMs expired");
});

test("ctx.signal: fetch-style consumer actually cancels on agent abort", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "net", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const ctl = new AbortController();
  let handlerObservedCancel = false;
  // Simulate fetch: a promise that rejects when its signal aborts.
  function fakeFetch(signal: AbortSignal): Promise<string> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      // never resolves on its own
    });
  }
  const tool: ToolDef = {
    name: "net",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      setTimeout(() => ctl.abort(), 5);
      try {
        return await fakeFetch(ctx.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          handlerObservedCancel = true;
          return "cancelled";
        }
        throw err;
      }
    },
  };
  // The handler observes the abort and returns; the next iteration's llm call
  // then rejects with the aborted signal. Both are expected.
  await assert.rejects(
    runAgent({
      llm,
      model: "m",
      tools: [tool],
      messages: [userMsg("hi")],
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(handlerObservedCancel, true);
});

test("ctx.signal: independent instance per dispatch (two tools in one turn)", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "p", { i: 1 }), toolUse("u2", "p", { i: 2 })], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const seen: AbortSignal[] = [];
  const tool: ToolDef = {
    name: "p",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      seen.push(ctx.signal);
      return "ok";
    },
  };
  await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "each dispatch must get its own AbortSignal");
});

test("ctx.signal: resumeAgent uses the resume call's signal, not the original", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "wt", {})], "tool_use"),
    response([text("done")], "end_turn"),
  ]);
  let observed: AbortSignal | undefined;
  const tool: ToolDef = {
    name: "wt",
    description: "",
    inputSchema: {},
    requiresConfirmation: true,
    summarize: () => "wt",
    handler: async (_input, ctx: ToolContext) => {
      observed = ctx.signal;
      return "ran";
    },
  };
  const originalCtl = new AbortController();
  originalCtl.abort(); // pre-aborted, would fire immediately if re-used
  const pendingConfirm: ConfirmCallback = async () => "pending";
  const first = await runAgent({
    llm,
    model: "m",
    tools: [tool],
    messages: [userMsg("go")],
    confirm: pendingConfirm,
    // intentionally NO signal here; resume supplies a fresh one
  });
  assert.ok(first.suspended);

  const resumeCtl = new AbortController();
  await resumeAgent({
    llm,
    model: "m",
    tools: [tool],
    suspended: first.suspended!,
    resume: { toolUseId: "u1", decision: "approve" },
    signal: resumeCtl.signal,
  });
  assert.ok(observed, "handler must have observed a signal");
  assert.equal(observed!.aborted, false, "resume signal is fresh and not aborted");
});

test("ctx.signal: withRetry preserves signal across the wrapped complete()", async () => {
  // Regression: withRetry.complete previously dropped the {signal} second-arg,
  // so handlers under withRetry never saw agent-abort propagation. This test
  // confirms the signal reaches ctx.signal even when the provider is wrapped.
  const { withRetry } = await import("../src/llm/retry.ts");
  const base = mockProvider([
    response([toolUse("u1", "wait", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const llm = withRetry(base, { maxAttempts: 2, baseMs: 1 });
  const ctl = new AbortController();
  let aborted = false;
  const tool: ToolDef = {
    name: "wait",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
        setTimeout(() => ctl.abort(), 5);
      });
      return "ok";
    },
  };
  await assert.rejects(
    runAgent({
      llm,
      model: "m",
      tools: [tool],
      messages: [userMsg("hi")],
      signal: ctl.signal,
    }),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(aborted, true, "ctx.signal should fire even when provider is wrapped by withRetry");
});

test("ctx.signal: placeholder never-aborts when no source is wired", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "probe", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  let observed!: AbortSignal;
  const tool: ToolDef = {
    name: "probe",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      observed = ctx.signal;
      return "ok";
    },
  };
  await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  // After the run completes, the placeholder signal should still be unaborted
  // — i.e., no unrelated abort source has leaked into it.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(observed.aborted, false);
});

test("ctx.signal: streamAgent path delivers same signal contract", async () => {
  const llm = mockProvider([
    response([toolUse("u1", "wait", {})], "tool_use"),
    response([text("ok")], "end_turn"),
  ]);
  const ctl = new AbortController();
  let aborted = false;
  const tool: ToolDef = {
    name: "wait",
    description: "",
    inputSchema: {},
    handler: async (_input, ctx: ToolContext) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
        setTimeout(() => ctl.abort(), 5);
      });
      return "ok";
    },
  };
  await assert.rejects(
    (async () => {
      for await (const _ev of streamAgent({
        llm,
        model: "m",
        tools: [tool],
        messages: [userMsg("hi")],
        signal: ctl.signal,
      })) {
        void _ev;
      }
    })(),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(aborted, true);
});
