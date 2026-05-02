import { anthropic, openaiCompat, streamAgent, type LLMProvider } from "../src/index.ts";

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
  if (!baseURL) throw new Error("LLM_BASE_URL not set (e.g. https://api.groq.com/openai/v1)");
  llm = openaiCompat({ apiKey, baseURL });
  model = process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";
} else {
  throw new Error(`unknown provider: ${provider}`);
}

process.stdout.write(`[${provider}:${model}] `);

const stream = streamAgent({
  llm,
  model,
  system: "You're a weather assistant. Use the get_weather tool to answer questions.",
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
      handler: async (input) => {
        const { city } = input as { city: string };
        return `It is 22°C and sunny in ${city}.`;
      },
    },
  ],
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
});

for await (const ev of stream) {
  switch (ev.type) {
    case "text_delta":
      process.stdout.write(ev.text);
      break;
    case "tool_dispatch_start":
      process.stdout.write(`\n[tool: ${ev.name}(${JSON.stringify(ev.input)})]\n`);
      break;
    case "tool_dispatch_done":
      process.stdout.write(`[result: ${ev.content.slice(0, 120)}]\n`);
      break;
    case "agent_done":
      process.stdout.write(
        `\n(${ev.result.iterations} iterations, stop=${ev.result.stopReason})\n`,
      );
      break;
  }
}
