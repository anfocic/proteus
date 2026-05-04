import type { RunAgentResult } from "./run.ts";

export interface ChainStep {
  specialist: string;
  result: RunAgentResult;
}

export type ChainContextFormatter = (
  prior: ChainStep | undefined,
  originalMessage: string,
  maxChars: number,
) => string;

export const DEFAULT_CHAIN_CONTEXT_CHARS = 2000;

/**
 * Default chain step input formatter — matches the intrebit shape:
 *   ${original}
 *
 *   <previous_step_output>${escaped + truncated}</previous_step_output>
 *
 * First step (no prior) returns the original message unchanged.
 */
export const defaultChainFormatter: ChainContextFormatter = (
  prior,
  originalMessage,
  maxChars,
) => {
  if (!prior) return originalMessage;
  const text = prior.result.finalText.slice(0, maxChars);
  return `${originalMessage}\n\n<previous_step_output>${escapeXmlAngles(text)}</previous_step_output>`;
};

export function escapeXmlAngles(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Thrown when a chain dispatch step fails. Carries the steps that completed
 * before the failure so callers can inspect partial progress.
 */
export class ChainDispatchError extends Error {
  readonly steps: ChainStep[];
  readonly failedAt: string;
  constructor(message: string, opts: { steps: ChainStep[]; failedAt: string; cause?: unknown }) {
    super(message);
    this.name = "ChainDispatchError";
    this.steps = opts.steps;
    this.failedAt = opts.failedAt;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}
