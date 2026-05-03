import { createServer } from "node:http";
import {
  anthropic,
  createSpecialist,
  createStreamingChatHandler,
  inMemoryStore,
  openaiCompat,
  type LLMProvider,
} from "../src/index.ts";

const provider = process.env.PROVIDER ?? "compat";

let llm: LLMProvider;
let model: string;

if (provider === "anthropic") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  llm = anthropic({ apiKey });
  model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
} else if (provider === "compat") {
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL;
  if (!apiKey) throw new Error("LLM_API_KEY not set");
  if (!baseURL) throw new Error("LLM_BASE_URL not set");
  llm = openaiCompat({ apiKey, baseURL });
  model = process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";
} else {
  throw new Error(`unknown provider: ${provider}`);
}

const weather = createSpecialist({
  name: "weather",
  description: "Questions about weather, climate, temperature, or atmospheric conditions",
  role: "You answer weather questions using the get_weather tool.",
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: async (input) => {
        const { city } = input as { city: string };
        const data: Record<string, string> = {
          Paris: "22°C, sunny",
          Tokyo: "18°C, light rain",
          Oslo: "8°C, overcast",
        };
        return data[city] ?? `It is 15°C and partly cloudy in ${city}.`;
      },
    },
  ],
});

const math = createSpecialist({
  name: "math",
  description: "Arithmetic, calculations, equations, or math word problems",
  role: "You solve math problems using the calculate tool.",
  tools: [
    {
      name: "calculate",
      description: "Apply a binary arithmetic operator to two numbers",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          op: { type: "string", enum: ["+", "-", "*", "/", "^"] },
        },
        required: ["a", "b", "op"],
      },
      handler: (input) => {
        const { a, b, op } = input as { a: number; b: number; op: string };
        switch (op) {
          case "+": return String(a + b);
          case "-": return String(a - b);
          case "*": return String(a * b);
          case "/": return String(a / b);
          case "^": return String(Math.pow(a, b));
          default: return `Unknown op: ${op}`;
        }
      },
    },
  ],
});

const handler = createStreamingChatHandler({
  llm,
  routerModel: model,
  specialistModel: model,
  specialists: [weather, math],
  services: {},
  store: inMemoryStore(),
});

const port = Number(process.env.PORT ?? 8787);

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chat") {
    res.statusCode = 404;
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { sessionId?: string; message?: string };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.end("invalid json");
    return;
  }
  if (!body.sessionId || !body.message) {
    res.statusCode = 400;
    res.end("sessionId and message required");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  try {
    for await (const ev of handler(
      { sessionId: body.sessionId, message: body.message },
      { signal: ctrl.signal },
    )) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`,
      );
    }
  }
  res.end();
});

server.listen(port, () => {
  console.log(`streaming chat server listening on http://localhost:${port}/chat`);
  console.log(`provider=${provider} model=${model}`);
  console.log(
    `try: curl -N -X POST http://localhost:${port}/chat -d '{"sessionId":"a","message":"weather in oslo"}'`,
  );
});
