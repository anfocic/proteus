import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  anthropic,
  createSpecialist,
  openaiCompat,
  runAgent,
  runSpecialist,
  type ToolDef,
} from "../src/index.ts";
import { mockProvider, response, text, userMsg } from "./_mock.ts";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function captureFetch(): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({
        id: "msg_x",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function captureFetchOpenAI(): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({
        id: "x",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("anthropic complete: cacheSystemPrompt=true → system is structured array with cache_control", async () => {
  const { captured, restore } = captureFetch();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "you are a weather agent",
      messages: [userMsg("hi")],
      cacheSystemPrompt: true,
    });
    const body = captured[0]!.body;
    assert.deepEqual(body.system, [
      { type: "text", text: "you are a weather agent", cache_control: { type: "ephemeral" } },
    ]);
  } finally {
    restore();
  }
});

test("anthropic complete: cacheSystemPrompt unset → system is bare string", async () => {
  const { captured, restore } = captureFetch();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "you are a weather agent",
      messages: [userMsg("hi")],
    });
    assert.equal(captured[0]!.body.system, "you are a weather agent");
  } finally {
    restore();
  }
});

test("anthropic complete: tool with cacheBreakpoint=true → cache_control on that tool", async () => {
  const { captured, restore } = captureFetch();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      messages: [userMsg("hi")],
      tools: [
        { name: "a", description: "", inputSchema: {} },
        { name: "b", description: "", inputSchema: {}, cacheBreakpoint: true },
      ],
    });
    const tools = captured[0]!.body.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.cache_control, undefined);
    assert.deepEqual(tools[1]!.cache_control, { type: "ephemeral" });
  } finally {
    restore();
  }
});

test("anthropic stream: cacheSystemPrompt + cacheBreakpoint propagate to streaming body", async () => {
  // SSE response with a single message_stop event, minimal valid stream.
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const llm = anthropic({ apiKey: "k" });
    const events = [];
    for await (const ev of llm.stream({
      model: "claude-x",
      system: "S",
      messages: [userMsg("hi")],
      cacheSystemPrompt: true,
      tools: [{ name: "t", description: "", inputSchema: {}, cacheBreakpoint: true }],
    })) {
      events.push(ev);
    }
    const body = captured[0]!.body;
    assert.deepEqual(body.system, [
      { type: "text", text: "S", cache_control: { type: "ephemeral" } },
    ]);
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools[0]!.cache_control, { type: "ephemeral" });
    assert.equal(body.stream, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("openai-compat: cache hints silently ignored (no cache_control anywhere)", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      system: "S",
      messages: [userMsg("hi")],
      cacheSystemPrompt: true,
      tools: [{ name: "t", description: "d", inputSchema: {}, cacheBreakpoint: true }],
    });
    const body = captured[0]!.body;
    const json = JSON.stringify(body);
    assert.ok(!json.includes("cache_control"), "no cache_control in openai body");
    assert.ok(!json.includes("cacheBreakpoint"), "no leaked normalized field name");
    assert.ok(!json.includes("cacheSystemPrompt"), "no leaked normalized field name");
    // System still in messages, tools still in standard openai shape.
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[0]!.content, "S");
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    assert.equal(tools[0]!.type, "function");
    assert.equal(tools[0]!.function.name, "t");
  } finally {
    restore();
  }
});

test("runAgent: ToolDef.cacheBreakpoint survives setup() and reaches provider", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const tool: ToolDef = {
    name: "t",
    description: "",
    inputSchema: {},
    cacheBreakpoint: true,
    handler: async () => "x",
  };
  await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const sentTools = llm.calls[0]!.tools!;
  assert.equal(sentTools[0]!.cacheBreakpoint, true);
});

test("runAgent: ToolDef without cacheBreakpoint does not pollute the schema with the field", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const tool: ToolDef = {
    name: "t",
    description: "",
    inputSchema: {},
    handler: async () => "x",
  };
  await runAgent({ llm, model: "m", tools: [tool], messages: [userMsg("hi")] });
  const sentTools = llm.calls[0]!.tools!;
  assert.ok(!("cacheBreakpoint" in sentTools[0]!), "field absent when unused");
});

test("runSpecialist: cacheRole=true → cacheSystemPrompt:true reaches provider", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const spec = createSpecialist({
    name: "weather",
    description: "",
    role: "you are weather",
    tools: [],
    cacheRole: true,
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "m",
    messages: [userMsg("hi")],
    services: {},
  });
  assert.equal(llm.calls[0]!.cacheSystemPrompt, true);
  assert.equal(llm.calls[0]!.system, "you are weather");
});

test("runSpecialist: cacheRole unset → cacheSystemPrompt undefined", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  const spec = createSpecialist({
    name: "weather",
    description: "",
    role: "you are weather",
    tools: [],
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "m",
    messages: [userMsg("hi")],
    services: {},
  });
  assert.equal(llm.calls[0]!.cacheSystemPrompt, undefined);
});
