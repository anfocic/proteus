import {
  anthropic,
  createSpecialist,
  openaiCompat,
  orchestrate,
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

const weatherSpecialist = createSpecialist({
  name: "weather",
  description: "Questions about weather, climate, temperature, or atmospheric conditions in a city",
  role: "You answer weather questions using the get_weather tool, then summarize briefly.",
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
          Reykjavik: "4°C, snow flurries",
        };
        return data[city] ?? `It is 15°C and partly cloudy in ${city}.`;
      },
    },
  ],
});

const mathSpecialist = createSpecialist({
  name: "math",
  description: "Arithmetic, calculations, equations, or math word problems",
  role:
    "You solve math problems using the calculate tool. Compose nested calls when needed " +
    "(e.g. 17² + 4 = calculate(17, 2, '^') then calculate(289, 4, '+')). " +
    "Reply with the final numeric answer.",
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
        let result: number;
        switch (op) {
          case "+": result = a + b; break;
          case "-": result = a - b; break;
          case "*": result = a * b; break;
          case "/": result = a / b; break;
          case "^": result = Math.pow(a, b); break;
          default: return `Unknown op: ${op}`;
        }
        return String(result);
      },
    },
  ],
});

const message = process.argv[2] ?? "What's the weather in Tokyo?";

const result = await orchestrate({
  llm,
  routerModel: model,
  specialistModel: model,
  specialists: [weatherSpecialist, mathSpecialist],
  services: {},
  message,
});

console.log(`[routed to: ${result.routedTo}] ${result.finalText}`);
console.log(
  `(router raw: ${JSON.stringify(result.routerRaw)}, ${result.iterations} iterations, stop=${result.stopReason})`,
);
