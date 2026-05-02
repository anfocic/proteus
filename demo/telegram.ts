import {
  anthropic,
  createChatHandler,
  createSpecialist,
  inMemoryStore,
  openaiCompat,
  type LLMProvider,
} from "../src/index.ts";
import { runPolling } from "../src/channel/telegram.ts";

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

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

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
  role: "You solve math problems using the calculate tool. Compose nested calls when needed.",
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

const handler = createChatHandler({
  llm,
  routerModel: model,
  specialistModel: model,
  specialists: [weather, math],
  services: {},
  store: inMemoryStore(),
});

const ctrl = new AbortController();
process.on("SIGINT", () => {
  console.log("\nshutting down...");
  ctrl.abort();
});

console.log(`telegram bot up (provider=${provider}, model=${model}) — Ctrl-C to exit`);

await runPolling({
  token,
  handler,
  signal: ctrl.signal,
  onError: (err, ctx) => {
    const chatId = ctx.update?.message?.chat.id;
    console.error(`[telegram] err${chatId ? ` chat=${chatId}` : ""}:`, err);
  },
});

console.log("telegram bot stopped");
