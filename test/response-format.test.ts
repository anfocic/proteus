import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  anthropic,
  openaiCompat,
  orchestrate,
  runAgent,
  runSpecialist,
  createSpecialist,
} from "../src/index.ts";
import { mockProvider, response, text, userMsg } from "./_mock.ts";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function captureFetchAnthropic(): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({
        id: "msg_x",
        content: [{ type: "text", text: '{"ok":true}' }],
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
        choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
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

const personSchema: Record<string, unknown> = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "number" } },
  required: ["name"],
};

// --- OpenAI-compat ----------------------------------------------------------

test("openai-compat: responseFormat=json_object → body.response_format set", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_object" },
    });
    assert.deepEqual(captured[0]!.body.response_format, { type: "json_object" });
  } finally {
    restore();
  }
});

test("openai-compat: responseFormat=json_schema → maps to native json_schema shape", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", name: "person", schema: personSchema, strict: true },
    });
    assert.deepEqual(captured[0]!.body.response_format, {
      type: "json_schema",
      json_schema: { name: "person", schema: personSchema, strict: true },
    });
  } finally {
    restore();
  }
});

test("openai-compat: responseFormat=json_schema without name → defaults to 'response'", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", schema: personSchema },
    });
    const rf = captured[0]!.body.response_format as {
      type: string;
      json_schema: { name: string; strict?: boolean };
    };
    assert.equal(rf.json_schema.name, "response");
    assert.equal(rf.json_schema.strict, undefined, "strict omitted when not set");
  } finally {
    restore();
  }
});

test("openai-compat: responseFormat unset → no response_format in body", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      messages: [userMsg("hi")],
    });
    assert.ok(
      !("response_format" in captured[0]!.body),
      "response_format must not appear when unset (stripped by stripUndefined)",
    );
  } finally {
    restore();
  }
});

// --- Anthropic --------------------------------------------------------------

test("anthropic: responseFormat=json_object → system prompt gains instruction block", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "you are an api",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_object" },
    });
    const system = captured[0]!.body.system as string;
    assert.equal(typeof system, "string");
    assert.ok(system.startsWith("you are an api"), "original system preserved at the start");
    assert.ok(
      system.includes("Respond with ONLY a valid JSON object"),
      "instruction text appended",
    );
  } finally {
    restore();
  }
});

test("anthropic: responseFormat=json_schema → schema rendered into system prompt", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "you are an api",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", name: "person", schema: personSchema },
    });
    const system = captured[0]!.body.system as string;
    assert.ok(system.includes("Respond with ONLY a JSON object matching the schema"));
    assert.ok(system.includes('"name"'), "schema rendered into the prompt");
    assert.ok(system.includes('"age"'), "schema properties present");
  } finally {
    restore();
  }
});

test("anthropic: responseFormat without system → instruction block becomes the system", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_object" },
    });
    const system = captured[0]!.body.system as string;
    assert.equal(typeof system, "string");
    assert.ok(system.startsWith("Respond with ONLY a valid JSON object"));
  } finally {
    restore();
  }
});

test("anthropic: responseFormat unset → system is bare string", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "plain prompt",
      messages: [userMsg("hi")],
    });
    assert.equal(captured[0]!.body.system, "plain prompt");
  } finally {
    restore();
  }
});

// --- Cache interaction (ADR 0014, item E) -----------------------------------

test("anthropic: responseFormat + cacheSystemPrompt → cache covers the FULL appended prompt", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      system: "you are an api",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", schema: personSchema },
      cacheSystemPrompt: true,
    });
    const system = captured[0]!.body.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    assert.ok(Array.isArray(system), "structured system array under cacheSystemPrompt");
    assert.equal(system.length, 1);
    assert.equal(system[0]!.type, "text");
    assert.ok(system[0]!.text.startsWith("you are an api"), "original prompt at the start");
    assert.ok(
      system[0]!.text.includes("Respond with ONLY a JSON object matching the schema"),
      "schema instruction inside the cached block",
    );
    assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" });
  } finally {
    restore();
  }
});

test("openai-compat: cache hints + responseFormat → response_format honoured, cache fields ignored", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      system: "S",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_object" },
      cacheSystemPrompt: true,
    });
    const body = captured[0]!.body;
    assert.deepEqual(body.response_format, { type: "json_object" });
    const json = JSON.stringify(body);
    assert.ok(!json.includes("cache_control"));
    assert.ok(!json.includes("cacheSystemPrompt"));
  } finally {
    restore();
  }
});

// --- Streaming path ---------------------------------------------------------

test("openai-compat stream: responseFormat appears in streaming request body", async () => {
  // Minimal valid SSE stream that emits one chunk then [DONE].
  const sse = [
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
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
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    const events = [];
    for await (const ev of llm.stream({
      model: "m",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", name: "p", schema: personSchema, strict: true },
    })) {
      events.push(ev);
    }
    const body = captured[0]!.body;
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: { name: "p", schema: personSchema, strict: true },
    });
    assert.equal(body.stream, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("anthropic stream: responseFormat instructions appear in streaming request body", async () => {
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
      system: "you are an api",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", schema: personSchema },
    })) {
      events.push(ev);
    }
    const system = captured[0]!.body.system as string;
    assert.ok(system.includes("Respond with ONLY a JSON object matching the schema"));
    assert.equal(captured[0]!.body.stream, true);
  } finally {
    globalThis.fetch = original;
  }
});

// --- Strict flag edge cases -------------------------------------------------

test("openai-compat: responseFormat with strict:false → strict:false forwarded (not stripped)", async () => {
  const { captured, restore } = captureFetchOpenAI();
  try {
    const llm = openaiCompat({ apiKey: "k", baseURL: "https://x" });
    await llm.complete({
      model: "m",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", schema: personSchema, strict: false },
    });
    const rf = captured[0]!.body.response_format as {
      json_schema: { strict?: boolean };
    };
    assert.equal(rf.json_schema.strict, false, "explicit strict:false must reach the body");
  } finally {
    restore();
  }
});

// --- Anthropic ignores strict ----------------------------------------------

test("anthropic: strict flag is never mentioned in the prompt-only instruction text", async () => {
  const { captured, restore } = captureFetchAnthropic();
  try {
    const llm = anthropic({ apiKey: "k" });
    await llm.complete({
      model: "claude-x",
      messages: [userMsg("hi")],
      responseFormat: { type: "json_schema", schema: personSchema, strict: true },
    });
    const system = captured[0]!.body.system as string;
    assert.ok(
      !/\bstrict\b/i.test(system),
      "anthropic prompt-only must not leak the 'strict' field — that's an OAI concept",
    );
  } finally {
    restore();
  }
});

// --- Round-trip via runAgent / runSpecialist / orchestrate ------------------

test("runAgent: responseFormat reaches llm.complete()", async () => {
  const llm = mockProvider([response([text('{"k":1}')], "end_turn")]);
  await runAgent({
    llm,
    model: "m",
    tools: [],
    messages: [userMsg("hi")],
    responseFormat: { type: "json_object" },
  });
  assert.deepEqual(llm.calls[0]!.responseFormat, { type: "json_object" });
});

test("runAgent: responseFormat unset → field absent on llm.complete() call", async () => {
  const llm = mockProvider([response([text("ok")], "end_turn")]);
  await runAgent({
    llm,
    model: "m",
    tools: [],
    messages: [userMsg("hi")],
  });
  assert.equal(llm.calls[0]!.responseFormat, undefined);
});

test("runSpecialist: responseFormat threads through to the provider", async () => {
  const llm = mockProvider([response([text('{"k":2}')], "end_turn")]);
  const spec = createSpecialist({
    name: "extractor",
    description: "",
    role: "you extract data",
    tools: [],
  });
  await runSpecialist({
    llm,
    specialist: spec,
    defaultModel: "m",
    messages: [userMsg("hi")],
    services: {},
    responseFormat: { type: "json_schema", schema: personSchema },
  });
  const rf = llm.calls[0]!.responseFormat as { type: string; schema?: object } | undefined;
  assert.ok(rf, "responseFormat should be forwarded");
  assert.equal(rf.type, "json_schema");
});

test("orchestrate: responseFormat reaches the dispatched specialist (not the router)", async () => {
  // Router call returns an intent classification; specialist call returns JSON.
  const llm = mockProvider([
    response([text('{"intents":["x"],"mode":"single"}')], "end_turn"),
    response([text('{"ok":1}')], "end_turn"),
  ]);
  const spec = createSpecialist({
    name: "x",
    description: "the one",
    role: "you respond in JSON",
    tools: [],
  });
  await orchestrate({
    llm,
    routerModel: "router",
    specialistModel: "specialist",
    specialists: [spec],
    services: {},
    message: "hi",
    responseFormat: { type: "json_object" },
  });
  // First call is the router (no responseFormat); second is the specialist (with responseFormat).
  assert.equal(llm.calls[0]!.responseFormat, undefined, "router call must NOT receive responseFormat");
  assert.deepEqual(llm.calls[1]!.responseFormat, { type: "json_object" });
});
