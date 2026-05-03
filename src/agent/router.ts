import type { LLMProvider } from "../llm/provider.ts";
import type { ContentBlock, Message, Usage } from "../llm/types.ts";

export interface Intent {
  name: string;
  description: string;
}

export interface ClassifyOpts {
  llm: LLMProvider;
  model: string;
  intents: Intent[];
  message: string;
  history?: Message[];
  fallback?: string;
}

export interface Classification {
  intent: string;
  raw: string;
  usage: Usage;
}

export async function classifyIntent(opts: ClassifyOpts): Promise<Classification> {
  if (opts.intents.length === 0) {
    throw new Error("classifyIntent: intents must be non-empty");
  }

  const system =
    "Classify the user's message into exactly one intent.\n\n" +
    "Intents:\n" +
    opts.intents.map((i) => `- ${i.name}: ${i.description}`).join("\n") +
    "\n\nReply with ONLY the intent name. No punctuation, no explanation.";

  const messages: Message[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.message },
  ];

  const res = await opts.llm.complete({
    model: opts.model,
    system,
    messages,
    maxTokens: 512,
    temperature: 0,
  });

  const textRaw = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  const raw = textRaw.trim()
    ? textRaw
    : res.content
        .filter((b) => b.type === "reasoning")
        .map((b) => (b as { text: string }).text)
        .join("");

  const intent = matchIntent(raw, opts.intents) ?? opts.fallback ?? opts.intents[0].name;
  return { intent, raw, usage: res.usage };
}

function matchIntent(raw: string, intents: Intent[]): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  for (const i of intents) {
    if (trimmed === i.name.toLowerCase()) return i.name;
  }

  const byLength = [...intents].sort((a, b) => b.name.length - a.name.length);
  for (const i of byLength) {
    if (trimmed.includes(i.name.toLowerCase())) return i.name;
  }

  return null;
}
