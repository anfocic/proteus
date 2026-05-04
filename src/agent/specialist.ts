import type { LLMProvider } from "../llm/provider.ts";
import type { Message } from "../llm/types.ts";
import {
  resumeAgent,
  runAgent,
  streamAgent,
  type AgentEvent,
  type ConfirmCallback,
  type ResumeDecision,
  type RunAgentResult,
  type SuspensionPayload,
  type ToolDef,
} from "./run.ts";

export interface Specialist<TServices = Record<string, unknown>> {
  name: string;
  description: string;
  role: string;
  tools: ToolDef<unknown, TServices>[];
  model?: string;
  /**
   * When true, the specialist's `role` is sent to the Anthropic adapter
   * with `cache_control: { type: "ephemeral" }`. Static specialist roles
   * are the canonical caching win — flip this on per-specialist when the
   * role is large and reused. Ignored on OpenAI-compat. ADR 0010.
   */
  cacheRole?: boolean;
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
  confirm?: ConfirmCallback;
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
    cacheSystemPrompt: opts.specialist.cacheRole,
    tools: opts.specialist.tools,
    messages: opts.messages,
    services: opts.services,
    confirm: opts.confirm,
    maxIterations: opts.maxIterations,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
  });
}

export interface ResumeSpecialistOpts<TServices> {
  llm: LLMProvider;
  specialist: Specialist<TServices>;
  defaultModel: string;
  services: TServices;
  suspended: SuspensionPayload;
  resume: ResumeDecision;
  confirm?: ConfirmCallback;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
}

export async function resumeSpecialist<TServices>(
  opts: ResumeSpecialistOpts<TServices>,
): Promise<RunAgentResult> {
  return resumeAgent({
    llm: opts.llm,
    model: opts.specialist.model ?? opts.defaultModel,
    system: opts.specialist.role,
    cacheSystemPrompt: opts.specialist.cacheRole,
    tools: opts.specialist.tools,
    services: opts.services,
    suspended: opts.suspended,
    resume: opts.resume,
    confirm: opts.confirm,
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
    cacheSystemPrompt: opts.specialist.cacheRole,
    tools: opts.specialist.tools,
    messages: opts.messages,
    services: opts.services,
    confirm: opts.confirm,
    maxIterations: opts.maxIterations,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
  });
}
