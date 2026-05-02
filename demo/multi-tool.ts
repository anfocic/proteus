import { anthropic, openaiCompat, runAgent, type LLMProvider } from "../src/index.ts";

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

const callLog: Array<{ tool: string; input: unknown }> = [];

const result = await runAgent({
  llm,
  model,
  system:
    "You're a travel assistant. Use tools to gather information, then summarize. Call multiple tools in one turn when possible.",
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
        callLog.push({ tool: "get_weather", input });
        const { city } = input as { city: string };
        const data: Record<string, string> = {
          Paris: "22°C, sunny",
          Tokyo: "18°C, light rain",
          Reykjavik: "4°C, snow flurries",
        };
        return data[city] ?? `unknown city: ${city}`;
      },
    },
    {
      name: "get_currency",
      description: "Get the local currency for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: async (input) => {
        callLog.push({ tool: "get_currency", input });
        const { city } = input as { city: string };
        const data: Record<string, string> = {
          Paris: "EUR",
          Tokyo: "JPY",
          Reykjavik: "ISK",
        };
        return data[city] ?? "unknown";
      },
    },
  ],
  messages: [
    {
      role: "user",
      content:
        "Compare Paris, Tokyo, and Reykjavik for a trip — weather and currency for each. Be brief.",
    },
  ],
  maxIterations: 6,
});

console.log(`[${provider}:${model}] ${result.finalText}\n`);
console.log(`(${result.iterations} iterations, stop=${result.stopReason})`);
console.log(`tool calls: ${callLog.length}`);

const byTool = callLog.reduce<Record<string, number>>((acc, c) => {
  acc[c.tool] = (acc[c.tool] ?? 0) + 1;
  return acc;
}, {});
console.log(`  ${JSON.stringify(byTool)}`);

const expected = 6;
if (callLog.length !== expected) {
  console.error(`\n⚠ expected ${expected} tool calls (3 cities × 2 tools), got ${callLog.length}`);
  process.exit(1);
}

const turnsWithMultipleCalls = result.messages.filter(
  (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.filter((b) => b.type === "tool_use").length > 1,
).length;
console.log(`assistant turns with >1 parallel tool call: ${turnsWithMultipleCalls}`);
if (turnsWithMultipleCalls === 0) {
  console.warn("⚠ no parallel tool calls observed — model issued tools serially");
}
