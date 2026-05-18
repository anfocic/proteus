import type { LLMProvider } from "../llm/provider.ts";
import type { Message, Usage } from "../llm/types.ts";
import { tryParseJSON } from "./json-repair.ts";

export interface Intent {
  name: string;
  description: string;
}

export type DispatchMode = "single" | "chain" | "parallel";

export interface ClassifyOpts {
  llm: LLMProvider;
  model: string;
  intents: Intent[];
  message: string;
  history?: Message[];
  /**
   * Caps how many intents the router is allowed to return. Defaults to 3.
   * Compound requests beyond this are truncated to the first N from the
   * model's response.
   */
  maxIntents?: number;
  /**
   * Forwarded to the router's `llm.complete()` call. Aborting cancels the
   * router classification request.
   */
  signal?: AbortSignal;
}

export interface Classification {
  /** Length >= 1. Falls back to the first registered intent when parsing fails. */
  intents: Intent[];
  mode: DispatchMode;
  reasoning?: string;
  usage: Usage;
}

const DEFAULT_MAX_INTENTS = 3;
const ROUTER_MAX_TOKENS = 320;

export async function classifyIntent(opts: ClassifyOpts): Promise<Classification> {
  if (opts.intents.length === 0) {
    throw new Error("classifyIntent: intents must be non-empty");
  }

  const maxIntents = opts.maxIntents ?? DEFAULT_MAX_INTENTS;
  const system = buildSystemPrompt(opts.intents);

  const messages: Message[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.message },
  ];

  const res = await opts.llm.complete(
    {
      model: opts.model,
      system,
      messages,
      maxTokens: ROUTER_MAX_TOKENS,
      temperature: 0,
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  const text = extractText(res.content);
  return parseClassification(text, opts.intents, res.usage, maxIntents);
}

function extractText(
  content: Array<{ type: string; text?: string }>,
): string {
  const textRaw = content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  if (textRaw.trim()) return textRaw;
  return content
    .filter((b) => b.type === "reasoning")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function buildSystemPrompt(intents: Intent[]): string {
  const list = intents.map((i) => `- ${i.name}: ${i.description}`).join("\n");
  return [
    "You are an intent classifier. Classify the user's message into one or more intents from the list below.",
    "",
    "## Intents",
    list,
    "",
    "## Compound Requests",
    'Use "chain" mode when one intent depends on another (e.g. "find X and show Y for it" needs the lookup first).',
    'Use "parallel" mode when intents are independent (e.g. two unrelated queries).',
    'Use "single" otherwise.',
    "",
    "## Response Format",
    "Respond with ONLY a JSON object, no other text:",
    '{"intents": ["name1"], "mode": "single", "reasoning": "brief"}',
    "",
    "For compound requests:",
    '{"intents": ["name1", "name2"], "mode": "chain", "reasoning": "brief"}',
  ].join("\n");
}

function parseClassification(
  text: string,
  registered: Intent[],
  usage: Usage,
  maxIntents: number,
): Classification {
  const fallback = (reason: string): Classification => ({
    intents: [registered[0]],
    mode: "single",
    reasoning: reason,
    usage,
  });

  const parsed = tryParseJSON(text);
  if (!parsed.ok) return fallback("router parse failed");

  const obj = parsed.value;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return fallback("router returned non-object");
  }
  const o = obj as Record<string, unknown>;

  const rawNames = Array.isArray(o.intents) ? o.intents : [];
  const names = rawNames.filter((n): n is string => typeof n === "string");
  const matched: Intent[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const hit = registered.find((i) => i.name === name);
    if (hit && !seen.has(hit.name)) {
      matched.push(hit);
      seen.add(hit.name);
    }
  }
  if (matched.length === 0) return fallback("router returned no known intents");
  const intents = matched.slice(0, Math.max(1, maxIntents));

  const rawMode = typeof o.mode === "string" ? o.mode : "single";
  const mode: DispatchMode =
    rawMode === "chain" || rawMode === "parallel" || rawMode === "single"
      ? rawMode
      : "single";

  const reasoning =
    typeof o.reasoning === "string" && o.reasoning.length > 0
      ? o.reasoning
      : undefined;

  return { intents, mode, reasoning, usage };
}
