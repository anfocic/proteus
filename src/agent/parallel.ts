import type { RunAgentResult } from "./run.ts";

export type ParallelStepResult =
  | { specialist: string; status: "fulfilled"; result: RunAgentResult }
  | { specialist: string; status: "rejected"; error: Error };

export type ParallelAggregator = (results: ParallelStepResult[]) => string;

export const PARALLEL_RESULT_SEPARATOR = "\n\n---\n\n";

/**
 * Default aggregator for `mode: "parallel"` — joins fulfilled `finalText`s
 * with `\n\n---\n\n`. Rejections are dropped from the joined text but
 * preserved on `OrchestrateResult.steps[]` so callers can inspect.
 *
 * Matches intrebit's behaviour (operator/src/orchestrator.ts:32-48).
 */
export const defaultParallelAggregator: ParallelAggregator = (results) =>
  results
    .filter((r): r is Extract<ParallelStepResult, { status: "fulfilled" }> => r.status === "fulfilled")
    .map((r) => r.result.finalText)
    .join(PARALLEL_RESULT_SEPARATOR);
