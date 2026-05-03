import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import { classifyIntent, type Intent } from "./router.ts";
import type { AgentEvent, RunAgentResult } from "./run.ts";
import { runSpecialist, streamSpecialist, type Specialist } from "./specialist.ts";

export interface OrchestrateOpts<TServices> {
  llm: LLMProvider;
  routerModel: string;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  message: string;
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
  });

  return { ...result, routedTo: chosen.name, routerRaw: cls.raw };
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
    signal: opts.signal,
  });

  return { ...agentResult, routedTo: chosen.name, routerRaw: cls.raw };
}
