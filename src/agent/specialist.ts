import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import {
  runAgent,
  streamAgent,
  type AgentEvent,
  type RunAgentResult,
  type ToolDef,
} from "./run.ts";

export interface Specialist<TServices = Record<string, unknown>> {
  name: string;
  description: string;
  role: string;
  tools: ToolDef<unknown, TServices>[];
  model?: string;
}

export function createSpecialist<TServices>(
  config: Specialist<TServices>,
): Specialist<TServices> {
  return config;
}

export interface RunSpecialistOpts<TServices> {
  llm: LLMProvider;
  specialist: Specialist<TServices>;
  defaultModel: string;
  messages: Message[];
  services: TServices;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
}

export async function runSpecialist<TServices>(
  opts: RunSpecialistOpts<TServices>,
): Promise<RunAgentResult> {
  return runAgent({
    llm: opts.llm,
    model: opts.specialist.model ?? opts.defaultModel,
    system: opts.specialist.role,
    tools: opts.specialist.tools,
    messages: opts.messages,
    services: opts.services,
    maxIterations: opts.maxIterations,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
}

export async function* streamSpecialist<TServices>(
  opts: RunSpecialistOpts<TServices> & { signal?: AbortSignal },
): AsyncGenerator<AgentEvent, RunAgentResult, void> {
  return yield* streamAgent({
    llm: opts.llm,
    model: opts.specialist.model ?? opts.defaultModel,
    system: opts.specialist.role,
    tools: opts.specialist.tools,
    messages: opts.messages,
    services: opts.services,
    maxIterations: opts.maxIterations,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  });
}
