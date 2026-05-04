import type { ContentBlock, Message } from "../llm/types.ts";

export type Tokenize = (text: string) => number;

export interface TrimToBudgetOpts {
  messages: Message[];
  maxTokens: number;
  /**
   * Required. Tokenizers are model-specific; shipping a default
   * 4-chars-per-token heuristic would silently mislead. Pass an explicit
   * function — e.g. `(s) => Math.ceil(s.length / 4)` for a rough estimate,
   * or your provider's actual tokenizer for accurate counts.
   */
  tokenize: Tokenize;
  /**
   * Always preserve the last N messages regardless of the budget. Default 1
   * (keeps the most recent user message even if it alone exceeds budget).
   */
  preserveLast?: number;
  /**
   * Per-message overhead added to the tokenize result, accounting for role
   * tags and formatting. Default 3 (intrebit's value).
   */
  perMessageOverhead?: number;
}

/**
 * Trim a message history to fit within a token budget. Walks newest →
 * oldest, dropping the oldest messages first. Always preserves at least
 * `preserveLast` messages (default 1) so a single oversized paste doesn't
 * wipe everything. Returns a new array; does not mutate the input.
 *
 * Counts message content via `tokenize` plus a small per-message overhead.
 * For `ContentBlock[]` content (assistant turns), text + reasoning blocks
 * are counted by their `text` field and tool_use blocks by
 * `JSON.stringify(input)`.
 *
 * Ported in spirit from intrebit operator/src/memory/session.ts.
 */
export function trimToBudget(opts: TrimToBudgetOpts): Message[] {
  const { messages, maxTokens, tokenize } = opts;
  const preserveLast = opts.preserveLast ?? 1;
  const overhead = opts.perMessageOverhead ?? 3;
  if (messages.length === 0) return [];

  const kept: Message[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateMessageCost(messages[i], tokenize) + overhead;
    if (kept.length >= preserveLast && total + cost > maxTokens) break;
    kept.push(messages[i]);
    total += cost;
  }
  return kept.reverse();
}

export function estimateMessageCost(msg: Message, tokenize: Tokenize): number {
  if (msg.role === "tool_result") return tokenize(msg.content);
  if (typeof msg.content === "string") return tokenize(msg.content);
  return msg.content.reduce((sum, block) => sum + estimateBlockCost(block, tokenize), 0);
}

function estimateBlockCost(block: ContentBlock, tokenize: Tokenize): number {
  if (block.type === "text") return tokenize(block.text);
  if (block.type === "reasoning") return tokenize(block.text);
  return tokenize(JSON.stringify(block.input));
}
