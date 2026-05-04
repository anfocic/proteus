import type { LLMProvider } from "../llm/provider.ts";
import type { Message, Usage } from "../llm/types.ts";
import { classifyIntent, type Intent } from "./router.ts";
import type { Classification } from "./router.ts";
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
import {
  ChainDispatchError,
  DEFAULT_CHAIN_CONTEXT_CHARS,
  defaultChainFormatter,
  type ChainContextFormatter,
  type ChainStep,
} from "./chain.ts";
import {
  defaultParallelAggregator,
  type ParallelAggregator,
  type ParallelStepResult,
} from "./parallel.ts";

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
   *
   * Single mode only — set on `mode: "chain"` throws.
   */
  evaluate?: EvaluatorFn;
  /**
   * Max specialist attempts when an evaluator is set. Default 2 (= 1 retry).
   */
  maxEvaluatorAttempts?: number;
  /**
   * Chain mode only. Max characters of the prior step's `finalText` carried
   * into the next step's user message. Default 2000 (intrebit's value).
   */
  chainContextChars?: number;
  /**
   * Chain mode only. Override the default `<previous_step_output>...` formatter.
   */
  chainContextFormatter?: ChainContextFormatter;
  /**
   * Parallel mode only. Override the default aggregator that joins fulfilled
   * step `finalText`s with `\n\n---\n\n`.
   */
  parallelAggregator?: ParallelAggregator;
}

export interface OrchestrateResult extends RunAgentResult {
  routedTo: string;
  /** Router-supplied reasoning, when present. */
  routerReasoning?: string;
  routerUsage: Usage;
  specialistUsage: Usage;
  evaluatorAttempts: number;
  evaluatorUsage: Usage;
  /**
   * Populated for `mode: "chain"` (`ChainStep[]`) or `mode: "parallel"`
   * (`ParallelStepResult[]`). Undefined for single mode (zero-overhead).
   */
  steps?: ChainStep[] | ParallelStepResult[];
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
    routerUsage: { inputTokens: 0, outputTokens: 0 },
    specialistUsage: result.usage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
  };
}

export type OrchestrateStreamEvent =
  | { type: "routed"; routedTo: string; routerReasoning?: string }
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

  switch (cls.mode) {
    case "single":
      return runSingle(opts, cls);
    case "chain":
      return runChain(opts, cls);
    case "parallel":
      return runParallel(opts, cls);
  }
}

async function runSingle<TServices>(
  opts: OrchestrateOpts<TServices>,
  cls: Classification,
): Promise<OrchestrateResult> {
  const intent = cls.intents[0];
  const chosen =
    opts.specialists.find((s) => s.name === intent.name) ?? opts.specialists[0];

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
    routerReasoning: cls.reasoning,
    routerUsage: cls.usage,
    specialistUsage,
    evaluatorAttempts: attempts,
    evaluatorUsage,
    usage: addUsage(addUsage(cls.usage, specialistUsage), evaluatorUsage),
  };
}

async function runParallel<TServices>(
  opts: OrchestrateOpts<TServices>,
  cls: Classification,
): Promise<OrchestrateResult> {
  if (opts.evaluate) {
    throw new Error(
      "orchestrate: 'evaluate' is not supported with mode=parallel — retrying one specialist would drop the others' work. Use single mode for evaluator-gated flows.",
    );
  }

  // Wrap confirm so parallel branches reject any "pending" decision: the
  // suspend/resume model assumes one inflight specialist per session, which
  // parallel dispatch breaks. The thrown sentinel is detected post-allSettled
  // and re-thrown at the orchestrate level (rather than silently dropping the
  // failed step).
  const PARALLEL_PENDING_SENTINEL = Symbol.for("orchestrate.parallel-pending");
  const confirm: ConfirmCallback | undefined = opts.confirm
    ? async (req) => {
        const decision = await opts.confirm!(req);
        if (decision === "pending") {
          const err = new Error(
            "orchestrate: 'pending' confirm decision is not supported in mode=parallel — use single mode for suspend/resume flows.",
          );
          (err as { sentinel?: symbol }).sentinel = PARALLEL_PENDING_SENTINEL;
          throw err;
        }
        return decision;
      }
    : undefined;

  const matched = cls.intents.map((intent) => ({
    intent,
    spec: opts.specialists.find((s) => s.name === intent.name),
  }));

  const settled = await Promise.allSettled(
    matched.map(({ intent, spec }) =>
      spec
        ? runSpecialist({
            llm: opts.llm,
            specialist: spec,
            defaultModel: opts.specialistModel,
            messages: [
              ...(opts.history ?? []),
              { role: "user", content: opts.message },
            ],
            services: opts.services,
            confirm,
          })
        : Promise.reject(
            new Error(`unknown specialist '${intent.name}' in parallel dispatch`),
          ),
    ),
  );

  // If any branch tripped the pending-in-parallel guard, escalate.
  for (const r of settled) {
    if (r.status === "rejected") {
      const reason = r.reason as { sentinel?: symbol; message?: string } | undefined;
      if (reason && reason.sentinel === PARALLEL_PENDING_SENTINEL) {
        throw r.reason;
      }
    }
  }

  const steps: ParallelStepResult[] = settled.map((r, i) => {
    const name = matched[i].intent.name;
    return r.status === "fulfilled"
      ? { specialist: name, status: "fulfilled", result: r.value }
      : { specialist: name, status: "rejected", error: r.reason instanceof Error ? r.reason : new Error(String(r.reason)) };
  });

  const aggregator = opts.parallelAggregator ?? defaultParallelAggregator;
  const finalText = aggregator(steps);

  let specialistUsage: Usage = zeroUsage();
  for (const s of steps) {
    if (s.status === "fulfilled") specialistUsage = addUsage(specialistUsage, s.result.usage);
  }

  return {
    finalText,
    messages: [],
    iterations: 0,
    stopReason: "end_turn",
    usage: addUsage(cls.usage, specialistUsage),
    routedTo: cls.intents.map((i) => i.name).join(","),
    routerReasoning: cls.reasoning,
    routerUsage: cls.usage,
    specialistUsage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
    steps,
  };
}

async function runChain<TServices>(
  opts: OrchestrateOpts<TServices>,
  cls: Classification,
): Promise<OrchestrateResult> {
  if (opts.evaluate) {
    throw new Error(
      "orchestrate: 'evaluate' is not supported with mode=chain — evaluator + chain retry semantics are deferred. Use single mode for evaluator-gated flows.",
    );
  }

  const formatter = opts.chainContextFormatter ?? defaultChainFormatter;
  const maxChars = opts.chainContextChars ?? DEFAULT_CHAIN_CONTEXT_CHARS;
  const steps: ChainStep[] = [];
  let specialistUsage: Usage = zeroUsage();
  let prior: ChainStep | undefined;

  for (const intent of cls.intents) {
    const chosen = opts.specialists.find((s) => s.name === intent.name);
    if (!chosen) {
      throw new ChainDispatchError(
        `orchestrate: chain step references unknown specialist '${intent.name}'`,
        { steps, failedAt: intent.name },
      );
    }
    const augmented = formatter(prior, opts.message, maxChars);
    const messages: Message[] = [
      ...(opts.history ?? []),
      { role: "user", content: augmented },
    ];
    let result: RunAgentResult;
    try {
      result = await runSpecialist({
        llm: opts.llm,
        specialist: chosen,
        defaultModel: opts.specialistModel,
        messages,
        services: opts.services,
        confirm: opts.confirm,
      });
    } catch (e) {
      throw new ChainDispatchError(
        `orchestrate: chain step '${intent.name}' failed`,
        { steps, failedAt: intent.name, cause: e },
      );
    }
    specialistUsage = addUsage(specialistUsage, result.usage);
    const step: ChainStep = { specialist: chosen.name, result };
    steps.push(step);
    prior = step;
  }

  const last = steps[steps.length - 1].result;
  return {
    ...last,
    routedTo: steps[steps.length - 1].specialist,
    routerReasoning: cls.reasoning,
    routerUsage: cls.usage,
    specialistUsage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
    usage: addUsage(cls.usage, specialistUsage),
    steps,
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

  if (cls.mode === "chain") {
    throw new Error("streamOrchestrate: chain mode not yet implemented");
  }
  if (cls.mode === "parallel") {
    throw new Error("streamOrchestrate: parallel mode not yet implemented");
  }

  const intent = cls.intents[0];
  const chosen =
    opts.specialists.find((s) => s.name === intent.name) ?? opts.specialists[0];

  yield { type: "routed", routedTo: chosen.name, routerReasoning: cls.reasoning };

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
    routerReasoning: cls.reasoning,
    routerUsage: cls.usage,
    specialistUsage: agentResult.usage,
    evaluatorAttempts: 1,
    evaluatorUsage: zeroUsage(),
    usage: addUsage(cls.usage, agentResult.usage),
  };
}
