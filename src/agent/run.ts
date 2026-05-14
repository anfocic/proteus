import type { LLMProvider } from "../llm/provider.ts";
import type {
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  ToolSchema,
  Usage,
} from "../llm/types.ts";
import type { ToolContext } from "./context.ts";
import { mapLimit } from "./concurrency.ts";

export interface ToolDef<TInput = unknown, TServices = Record<string, unknown>> extends ToolSchema {
  handler: (input: TInput, ctx: ToolContext<TServices>) => Promise<string> | string;
  requiresConfirmation?: boolean;
  summarize?: (input: TInput) => string;
  timeoutMs?: number;
  maxResultBytes?: number;
}

export interface ConfirmRequest {
  toolUseId: string;
  name: string;
  input: unknown;
  summary: string;
}

export type ConfirmDecision = boolean | "pending";

export type ConfirmCallback = (req: ConfirmRequest) => Promise<ConfirmDecision>;

export interface RunAgentInput<TServices = Record<string, unknown>> {
  llm: LLMProvider;
  model: string;
  system?: string;
  tools: ToolDef<unknown, TServices>[];
  messages: Message[];
  services?: TServices;
  confirm?: ConfirmCallback;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  cacheSystemPrompt?: boolean;
  /**
   * Forwarded to `llm.complete()` / `llm.stream()`. Aborting cancels the
   * in-flight provider call; the rejection (a `DOMException` named
   * `AbortError`) propagates out of `runAgent` / `streamAgent` unwrapped.
   */
  signal?: AbortSignal;
  /**
   * Cap on concurrent tool-handler executions within a single turn. When the
   * model emits a batch of `tool_use` blocks, handlers run with at most this
   * many in flight at once. Ordering of `tool_result` messages is preserved.
   *
   * Confirmation gates remain serialized regardless of this cap (one prompt
   * at a time). Undefined or <= 0 → unbounded (existing behavior).
   */
  toolConcurrency?: number;
}

export type RunAgentStopReason =
  | "end_turn"
  | "max_iterations"
  | "max_tokens"
  | "error"
  | "pending";

export interface PendingTool {
  toolUseId: string;
  name: string;
  input: unknown;
  summary: string;
}

export interface SuspensionPayload {
  pending: PendingTool;
  /**
   * Conversation messages BEFORE the assistant turn that triggered the gate.
   * On resume, the assistant turn is re-attached from `turnContent`, and any
   * already-resolved tool_results in `decided` are emitted in original order
   * once the turn finishes dispatching.
   */
  messages: Message[];
  turnContent: ContentBlock[];
  /**
   * Map of toolUseId → resolved result. Captures decisions made before the
   * pending one (typically non-confirm tools that ran inline, or earlier
   * confirms that resolved).
   */
  decided: Record<string, ToolResultRecord>;
  iteration: number;
  usage: Usage;
}

export interface RunAgentResult {
  messages: Message[];
  finalText: string;
  iterations: number;
  stopReason: RunAgentStopReason;
  usage: Usage;
  suspended?: SuspensionPayload;
}

export const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cc = sumOptional(a.cacheCreationInputTokens, b.cacheCreationInputTokens);
  if (cc !== undefined) out.cacheCreationInputTokens = cc;
  const cr = sumOptional(a.cacheReadInputTokens, b.cacheReadInputTokens);
  if (cr !== undefined) out.cacheReadInputTokens = cr;
  return out;
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export interface ResumeDecision {
  toolUseId: string;
  decision: "approve" | "decline";
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultRecord = { toolUseId: string; content: string; isError: boolean };
type ToolMap = Map<string, ToolDef<unknown, unknown>>;

function summarizeInput(tool: ToolDef<unknown, unknown> | undefined, input: unknown): string {
  if (tool?.summarize) {
    try {
      return tool.summarize(input);
    } catch {
      // fall through to JSON
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function declinedResult(tu: ToolUseBlock, summary: string): ToolResultRecord {
  return {
    toolUseId: tu.id,
    content: `[DECLINED] User declined this action: ${summary}`,
    isError: true,
  };
}

class ToolTimeoutError extends Error {
  constructor() {
    super("tool timeout");
    this.name = "ToolTimeoutError";
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new ToolTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

function applyCap(s: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined) return s;
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
  return `${head}\n\n[TRUNCATED: ${maxBytes} of ${bytes.length} bytes]`;
}

async function runHandler(
  tu: ToolUseBlock,
  tools: ToolMap,
  ctx: ToolContext<unknown>,
): Promise<ToolResultRecord> {
  const tool = tools.get(tu.name);
  if (!tool) {
    return { toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true };
  }
  try {
    const handlerPromise = Promise.resolve(tool.handler(tu.input, ctx));
    const out =
      tool.timeoutMs !== undefined
        ? await raceWithTimeout(handlerPromise, tool.timeoutMs)
        : await handlerPromise;
    return { toolUseId: tu.id, content: applyCap(out, tool.maxResultBytes), isError: false };
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return {
        toolUseId: tu.id,
        content: `[TIMEOUT] Tool exceeded ${tool.timeoutMs}ms`,
        isError: true,
      };
    }
    return {
      toolUseId: tu.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

type TurnDispatchResult =
  | { kind: "complete"; toolResults: ToolResultRecord[] }
  | { kind: "pending"; pending: PendingTool; decided: Record<string, ToolResultRecord> };

async function dispatchTurn(
  toolUses: ToolUseBlock[],
  tools: ToolMap,
  ctx: ToolContext<unknown>,
  confirm: ConfirmCallback | undefined,
  seed: Record<string, ToolResultRecord> = {},
  toolConcurrency?: number,
): Promise<TurnDispatchResult> {
  const decided: Record<string, ToolResultRecord> = { ...seed };
  type GateOutcome =
    | { kind: "approved"; tu: ToolUseBlock }
    | { kind: "decided"; result: ToolResultRecord };
  const outcomes: GateOutcome[] = [];

  for (const tu of toolUses) {
    if (decided[tu.id]) {
      outcomes.push({ kind: "decided", result: decided[tu.id] });
      continue;
    }

    const tool = tools.get(tu.name);
    if (!tool) {
      const result: ToolResultRecord = {
        toolUseId: tu.id,
        content: `Unknown tool: ${tu.name}`,
        isError: true,
      };
      decided[tu.id] = result;
      outcomes.push({ kind: "decided", result });
      continue;
    }

    if (!tool.requiresConfirmation) {
      outcomes.push({ kind: "approved", tu });
      continue;
    }

    const summary = summarizeInput(tool, tu.input);
    if (!confirm) {
      const result: ToolResultRecord = {
        toolUseId: tu.id,
        content: "Tool requires confirmation but no confirm handler was provided",
        isError: true,
      };
      decided[tu.id] = result;
      outcomes.push({ kind: "decided", result });
      continue;
    }

    const decision = await confirm({ toolUseId: tu.id, name: tu.name, input: tu.input, summary });
    if (decision === "pending") {
      return {
        kind: "pending",
        pending: { toolUseId: tu.id, name: tu.name, input: tu.input, summary },
        decided,
      };
    }
    if (decision === false) {
      const result = declinedResult(tu, summary);
      decided[tu.id] = result;
      outcomes.push({ kind: "decided", result });
    } else {
      outcomes.push({ kind: "approved", tu });
    }
  }

  const results = await mapLimit(outcomes, toolConcurrency, (o) =>
    o.kind === "decided" ? Promise.resolve(o.result) : runHandler(o.tu, tools, ctx),
  );
  return { kind: "complete", toolResults: results };
}

interface AgentLoopState<TServices> {
  input: RunAgentInput<TServices>;
  tools: ToolMap;
  toolSchemas: ToolSchema[];
  ctx: ToolContext<unknown>;
  maxIterations: number;
}

function setup<TServices>(input: Omit<RunAgentInput<TServices>, "messages">): AgentLoopState<TServices> {
  const tools: ToolMap = new Map(
    input.tools.map((t) => [t.name, t as ToolDef<unknown, unknown>]),
  );
  const toolSchemas: ToolSchema[] = input.tools.map(
    ({ name, description, inputSchema, cacheBreakpoint }) =>
      cacheBreakpoint
        ? { name, description, inputSchema, cacheBreakpoint }
        : { name, description, inputSchema },
  );
  const ctx: ToolContext<unknown> = {
    services: (input.services ?? {}) as unknown,
  };
  return {
    input: input as RunAgentInput<TServices>,
    tools,
    toolSchemas,
    ctx,
    maxIterations: input.maxIterations ?? 5,
  };
}

async function loop<TServices>(
  state: AgentLoopState<TServices>,
  initialMessages: Message[],
  startIteration: number,
  startUsage: Usage = zeroUsage(),
): Promise<RunAgentResult> {
  const messages: Message[] = [...initialMessages];
  let iterations = startIteration;
  let usage = startUsage;

  while (iterations < state.maxIterations) {
    iterations++;

    const res = await state.input.llm.complete(
      {
        model: state.input.model,
        system: state.input.system,
        messages,
        tools: state.toolSchemas.length > 0 ? state.toolSchemas : undefined,
        maxTokens: state.input.maxTokens,
        temperature: state.input.temperature,
        cacheSystemPrompt: state.input.cacheSystemPrompt,
      },
      state.input.signal ? { signal: state.input.signal } : undefined,
    );

    usage = addUsage(usage, res.usage);
    messages.push({ role: "assistant", content: res.content });

    if (res.stopReason !== "tool_use") {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: res.stopReason,
        usage,
      };
    }

    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "end_turn",
        usage,
      };
    }

    const dispatch = await dispatchTurn(
      toolUses,
      state.tools,
      state.ctx,
      state.input.confirm,
      undefined,
      state.input.toolConcurrency,
    );
    if (dispatch.kind === "pending") {
      messages.pop();
      return {
        messages,
        finalText: "",
        iterations,
        stopReason: "pending",
        usage,
        suspended: {
          pending: dispatch.pending,
          messages,
          turnContent: res.content,
          decided: dispatch.decided,
          iteration: iterations,
          usage,
        },
      };
    }

    for (const r of dispatch.toolResults) {
      messages.push({
        role: "tool_result",
        toolUseId: r.toolUseId,
        content: r.content,
        isError: r.isError,
      });
    }
  }

  const last = messages[messages.length - 1];
  const finalText =
    last && last.role === "assistant" ? extractText(last.content as ContentBlock[]) : "";
  return { messages, finalText, iterations, stopReason: "max_iterations", usage };
}

export async function runAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices>,
): Promise<RunAgentResult> {
  return loop(setup(input), input.messages, 0);
}

export interface ResumeAgentInput<TServices = Record<string, unknown>>
  extends Omit<RunAgentInput<TServices>, "messages"> {
  suspended: SuspensionPayload;
  resume: ResumeDecision;
}

export async function resumeAgent<TServices = Record<string, unknown>>(
  input: ResumeAgentInput<TServices>,
): Promise<RunAgentResult> {
  const { suspended, resume } = input;
  if (resume.toolUseId !== suspended.pending.toolUseId) {
    throw new Error(
      `resumeAgent: decision toolUseId ${resume.toolUseId} does not match suspended toolUseId ${suspended.pending.toolUseId}`,
    );
  }
  const state = setup(input);

  const toolUses = suspended.turnContent.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const seed: Record<string, ToolResultRecord> = { ...suspended.decided };
  if (resume.decision === "decline") {
    seed[resume.toolUseId] = {
      toolUseId: resume.toolUseId,
      content: `[DECLINED] User declined this action: ${suspended.pending.summary}`,
      isError: true,
    };
  } else {
    const tu = toolUses.find((t) => t.id === resume.toolUseId);
    if (!tu) {
      throw new Error(`resumeAgent: pending toolUseId ${resume.toolUseId} not in saved turn`);
    }
    seed[tu.id] = await runHandler(tu, state.tools, state.ctx);
  }

  const dispatch = await dispatchTurn(
    toolUses,
    state.tools,
    state.ctx,
    input.confirm,
    seed,
    input.toolConcurrency,
  );
  const messagesWithTurn = [...suspended.messages, { role: "assistant" as const, content: suspended.turnContent }];

  if (dispatch.kind === "pending") {
    return {
      messages: suspended.messages,
      finalText: "",
      iterations: suspended.iteration,
      stopReason: "pending",
      usage: suspended.usage,
      suspended: {
        pending: dispatch.pending,
        messages: suspended.messages,
        turnContent: suspended.turnContent,
        decided: dispatch.decided,
        iteration: suspended.iteration,
        usage: suspended.usage,
      },
    };
  }

  for (const r of dispatch.toolResults) {
    messagesWithTurn.push({
      role: "tool_result",
      toolUseId: r.toolUseId,
      content: r.content,
      isError: r.isError,
    });
  }

  return loop(state, messagesWithTurn, suspended.iteration, suspended.usage);
}

export type AgentEvent =
  | StreamEvent
  | { type: "tool_confirm_request"; toolUseId: string; name: string; input: unknown; summary: string }
  | { type: "tool_confirm_response"; toolUseId: string; confirmed: boolean }
  | { type: "tool_dispatch_start"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_dispatch_done"; toolUseId: string; content: string; isError: boolean }
  | { type: "agent_done"; result: RunAgentResult };

export async function* streamAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices>,
): AsyncGenerator<AgentEvent, RunAgentResult, void> {
  const state = setup(input);
  const messages: Message[] = [...input.messages];
  let iterations = 0;
  let usage = zeroUsage();

  while (iterations < state.maxIterations) {
    iterations++;

    let turnContent: ContentBlock[] = [];
    let turnStop: StopReason = "error";
    let turnUsage: Usage = zeroUsage();

    for await (const ev of input.llm.stream(
      {
        model: input.model,
        system: input.system,
        messages,
        tools: state.toolSchemas.length > 0 ? state.toolSchemas : undefined,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        cacheSystemPrompt: input.cacheSystemPrompt,
      },
      input.signal ? { signal: input.signal } : undefined,
    )) {
      yield ev;
      if (ev.type === "message_stop") {
        turnContent = ev.content;
        turnStop = ev.stopReason;
        turnUsage = ev.usage;
      }
    }
    usage = addUsage(usage, turnUsage);
    messages.push({ role: "assistant", content: turnContent });

    if (turnStop !== "tool_use") {
      const result: RunAgentResult = {
        messages,
        finalText: extractText(turnContent),
        iterations,
        stopReason: turnStop,
        usage,
      };
      yield { type: "agent_done", result };
      return result;
    }

    const toolUses = turnContent.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      const result: RunAgentResult = {
        messages,
        finalText: extractText(turnContent),
        iterations,
        stopReason: "end_turn",
        usage,
      };
      yield { type: "agent_done", result };
      return result;
    }

    type GateOutcome =
      | { kind: "approved"; tu: ToolUseBlock }
      | { kind: "decided"; result: ToolResultRecord };
    const outcomes: GateOutcome[] = [];
    let pendingHit = false;

    for (const tu of toolUses) {
      const tool = state.tools.get(tu.name);
      if (!tool) {
        outcomes.push({
          kind: "decided",
          result: { toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true },
        });
        continue;
      }
      if (!tool.requiresConfirmation) {
        outcomes.push({ kind: "approved", tu });
        continue;
      }
      const summary = summarizeInput(tool, tu.input);
      yield {
        type: "tool_confirm_request",
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        summary,
      };
      if (!input.confirm) {
        outcomes.push({
          kind: "decided",
          result: {
            toolUseId: tu.id,
            content: "Tool requires confirmation but no confirm handler was provided",
            isError: true,
          },
        });
        continue;
      }
      const decision = await input.confirm({
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        summary,
      });
      if (decision === "pending") {
        pendingHit = true;
        break;
      }
      yield { type: "tool_confirm_response", toolUseId: tu.id, confirmed: decision === true };
      if (decision) {
        outcomes.push({ kind: "approved", tu });
      } else {
        outcomes.push({ kind: "decided", result: declinedResult(tu, summary) });
      }
    }

    if (pendingHit) {
      throw new Error(
        "streamAgent does not support 'pending' confirm decisions — use runAgent + resumeAgent for suspend/resume",
      );
    }

    for (const o of outcomes) {
      if (o.kind === "approved") {
        yield {
          type: "tool_dispatch_start",
          toolUseId: o.tu.id,
          name: o.tu.name,
          input: o.tu.input,
        };
      }
    }

    const results = await mapLimit(outcomes, input.toolConcurrency, (o) =>
      o.kind === "decided" ? Promise.resolve(o.result) : runHandler(o.tu, state.tools, state.ctx),
    );

    for (const r of results) {
      yield {
        type: "tool_dispatch_done",
        toolUseId: r.toolUseId,
        content: r.content,
        isError: r.isError,
      };
      messages.push({
        role: "tool_result",
        toolUseId: r.toolUseId,
        content: r.content,
        isError: r.isError,
      });
    }
  }

  const last = messages[messages.length - 1];
  const finalText =
    last && last.role === "assistant" ? extractText(last.content as ContentBlock[]) : "";
  const result: RunAgentResult = {
    messages,
    finalText,
    iterations,
    stopReason: "max_iterations",
    usage,
  };
  yield { type: "agent_done", result };
  return result;
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}
