import type { LLMProvider } from "../llm/provider.ts";
import type { Message, Usage } from "../llm/types.ts";
import { classifyIntent, type Intent } from "./router.ts";
import {
  addUsage,
  zeroUsage,
  type AgentEvent,
  type ConfirmCallback,
  type RunAgentResult,
} from "./run.ts";
import {
  resumeSpecialist,
  runSpecialist,
  streamSpecialist,
  type Specialist,
} from "./specialist.ts";

export interface EvaluatorInput {
  finalText: string;
  messages: Message[];
  attempt: number;
  routedTo: string;
}

export interface EvaluatorVerdict {
  ok: boolean;
  feedback?: string;
  usage?: Usage;
}

export type EvaluatorFn = (input: EvaluatorInput) => Promise<EvaluatorVerdict>;

const DEFAULT_FEEDBACK = "Please reconsider your previous response and try again.";
const DEFAULT_MAX_EVALUATOR_ATTEMPTS = 2;

export interface OrchestrateOpts<TServices> {
  llm: LLMProvider;
  routerModel: string;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  message: string;
  confirm?: ConfirmCallback;
  /**
   * Prior conversation. Should contain only `user` and plain-text `assistant`
   * messages. Tool transcripts (assistant `tool_use` blocks + `tool_result`
   * messages) from a prior specialist are unsafe to re-feed: a different
   * specialist invoked next turn won't have those tool ids in its schema and
   * the upstream provider may reject the request.
   */
  history?: Message[];
  /**
   * Optional quality gate. Runs after the specialist returns. If `ok: false`,
   * the specialist is re-run with `feedback` (or a default reconsider prompt)
   * appended as a user message, bounded by `maxEvaluatorAttempts`. Caller
   * writes the LLM call (or heuristic) — no built-in evaluator. Reports its
   * own LLM cost via `usage` on the verdict.
   */
  evaluate?: EvaluatorFn;
  /**
   * Max specialist attempts when an evaluator is set. Default 2 (= 1 retry).
   * 1 = evaluate-only (no retry, useful for telemetry). Ignored if `evaluate`
   * is undefined. At cap with `ok: false`, the last result is returned
   * without throwing — caller can detect via `evaluatorAttempts === maxEvaluatorAttempts`.
   */
  maxEvaluatorAttempts?: number;
}

export interface OrchestrateResult extends RunAgentResult {
  routedTo: string;
  routerRaw: string;
  routerUsage: Usage;
  specialistUsage: Usage;
  evaluatorAttempts: number;
  evaluatorUsage: Usage;
}

export interface ResumeOrchestrateOpts<TServices> {
  llm: LLMProvider;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  routedTo: string;
  suspended: import("./run.ts").SuspensionPayload;
  resume: import("./run.ts").ResumeDecision;
  confirm?: ConfirmCallback;
}

export async function resumeOrchestrate<TServices>(
  opts: ResumeOrchestrateOpts<TServices>,
): Promise<OrchestrateResult> {
  const chosen = opts.specialists.find((s) => s.name === opts.routedTo);
  if (!chosen) {
    throw new Error(`resumeOrchestrate: unknown specialist ${opts.routedTo}`);
  }
  const result = await resumeSpecialist({
    llm: opts.llm,
    specialist: chosen,
    defaultModel: opts.specialistModel,
    services: opts.services,
    suspended: opts.suspended,
    resume: opts.resume,
    confirm: opts.confirm,
  });
  return {
    ...result,
    routedTo: chosen.name,
    routerRaw: "",
    routerUsage: { inputTokens: 0, outputTokens: 0 },
    specialistUsage: result.usage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
  };
}

export type OrchestrateStreamEvent =
  | { type: "routed"; routedTo: string; routerRaw: string }
  | AgentEvent;

function intentsOf<TServices>(specialists: Specialist<TServices>[]): Intent[] {
  if (specialists.length === 0) {
    throw new Error("orchestrate: specialists must be non-empty");
  }
  return specialists.map((s) => ({ name: s.name, description: s.description }));
}

export async function orchestrate<TServices>(
  opts: OrchestrateOpts<TServices>,
): Promise<OrchestrateResult> {
  const intents = intentsOf(opts.specialists);

  const cls = await classifyIntent({
    llm: opts.llm,
    model: opts.routerModel,
    intents,
    message: opts.message,
    history: opts.history,
  });

  const chosen =
    opts.specialists.find((s) => s.name === cls.intent) ?? opts.specialists[0];

  const maxAttempts = Math.max(1, opts.maxEvaluatorAttempts ?? DEFAULT_MAX_EVALUATOR_ATTEMPTS);
  let messages: Message[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.message },
  ];

  let attempts = 0;
  let specialistUsage: Usage = zeroUsage();
  let evaluatorUsage: Usage = zeroUsage();
  let result!: RunAgentResult;

  while (attempts < maxAttempts) {
    attempts++;
    result = await runSpecialist({
      llm: opts.llm,
      specialist: chosen,
      defaultModel: opts.specialistModel,
      messages,
      services: opts.services,
      confirm: opts.confirm,
    });
    specialistUsage = addUsage(specialistUsage, result.usage);

    if (!opts.evaluate) break;

    const verdict = await opts.evaluate({
      finalText: result.finalText,
      messages: result.messages,
      attempt: attempts,
      routedTo: chosen.name,
    });
    if (verdict.usage) evaluatorUsage = addUsage(evaluatorUsage, verdict.usage);
    if (verdict.ok || attempts >= maxAttempts) break;

    messages = [
      ...result.messages,
      { role: "user", content: verdict.feedback ?? DEFAULT_FEEDBACK },
    ];
  }

  return {
    ...result,
    routedTo: chosen.name,
    routerRaw: cls.raw,
    routerUsage: cls.usage,
    specialistUsage,
    evaluatorAttempts: attempts,
    evaluatorUsage,
    usage: addUsage(addUsage(cls.usage, specialistUsage), evaluatorUsage),
  };
}

export async function* streamOrchestrate<TServices>(
  opts: OrchestrateOpts<TServices> & { signal?: AbortSignal },
): AsyncGenerator<OrchestrateStreamEvent, OrchestrateResult, void> {
  if (opts.evaluate) {
    throw new Error(
      "streamOrchestrate does not support 'evaluate' — deltas have already reached the consumer when the evaluator runs, so a retry would duplicate output. Use buffered orchestrate() for evaluator-gated flows.",
    );
  }
  const intents = intentsOf(opts.specialists);

  const cls = await classifyIntent({
    llm: opts.llm,
    model: opts.routerModel,
    intents,
    message: opts.message,
    history: opts.history,
  });

  const chosen =
    opts.specialists.find((s) => s.name === cls.intent) ?? opts.specialists[0];

  yield { type: "routed", routedTo: chosen.name, routerRaw: cls.raw };

  const agentResult = yield* streamSpecialist({
    llm: opts.llm,
    specialist: chosen,
    defaultModel: opts.specialistModel,
    messages: [...(opts.history ?? []), { role: "user", content: opts.message }],
    services: opts.services,
    confirm: opts.confirm,
    signal: opts.signal,
  });

  return {
    ...agentResult,
    routedTo: chosen.name,
    routerRaw: cls.raw,
    routerUsage: cls.usage,
    specialistUsage: agentResult.usage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
    usage: addUsage(cls.usage, agentResult.usage),
  };
}
