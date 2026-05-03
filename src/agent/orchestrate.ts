import type { LLMProvider } from "../llm/provider.ts";
import type { Message, Usage } from "../llm/types.ts";
import { classifyIntent, type Intent } from "./router.ts";
import { addUsage, type AgentEvent, type ConfirmCallback, type RunAgentResult } from "./run.ts";
import {
  resumeSpecialist,
  runSpecialist,
  streamSpecialist,
  type Specialist,
} from "./specialist.ts";

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
}

export interface OrchestrateResult extends RunAgentResult {
  routedTo: string;
  routerRaw: string;
  routerUsage: Usage;
  specialistUsage: Usage;
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

  const result = await runSpecialist({
    llm: opts.llm,
    specialist: chosen,
    defaultModel: opts.specialistModel,
    messages: [...(opts.history ?? []), { role: "user", content: opts.message }],
    services: opts.services,
    confirm: opts.confirm,
  });

  return {
    ...result,
    routedTo: chosen.name,
    routerRaw: cls.raw,
    routerUsage: cls.usage,
    specialistUsage: result.usage,
    usage: addUsage(cls.usage, result.usage),
  };
}

export async function* streamOrchestrate<TServices>(
  opts: OrchestrateOpts<TServices> & { signal?: AbortSignal },
): AsyncGenerator<OrchestrateStreamEvent, OrchestrateResult, void> {
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
    usage: addUsage(cls.usage, agentResult.usage),
  };
}
