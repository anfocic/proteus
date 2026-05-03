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

export interface ToolDef<TInput = unknown, TServices = Record<string, unknown>> extends ToolSchema {
  handler: (input: TInput, ctx: ToolContext<TServices>) => Promise<string> | string;
  requiresConfirmation?: boolean;
  summarize?: (input: TInput) => string;
}

export interface ConfirmRequest {
  toolUseId: string;
  name: string;
  input: unknown;
  summary: string;
}

export type ConfirmCallback = (req: ConfirmRequest) => Promise<boolean>;

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
}

export interface RunAgentResult {
  messages: Message[];
  finalText: string;
  iterations: number;
  stopReason: "end_turn" | "max_iterations" | "max_tokens" | "error";
  usage: Usage;
}

export const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultRecord = { toolUseId: string; content: string; isError: boolean };
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

async function gateTool(
  tu: ToolUseBlock,
  tools: ToolMap,
  confirm: ConfirmCallback | undefined,
): Promise<{ approved: true; summary: string } | { approved: false; result: ToolResultRecord }> {
  const tool = tools.get(tu.name);
  if (!tool) {
    return {
      approved: false,
      result: { toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true },
    };
  }
  if (!tool.requiresConfirmation) {
    return { approved: true, summary: "" };
  }
  const summary = summarizeInput(tool, tu.input);
  if (!confirm) {
    return {
      approved: false,
      result: {
        toolUseId: tu.id,
        content: "Tool requires confirmation but no confirm handler was provided",
        isError: true,
      },
    };
  }
  const ok = await confirm({ toolUseId: tu.id, name: tu.name, input: tu.input, summary });
  if (!ok) {
    return {
      approved: false,
      result: {
        toolUseId: tu.id,
        content: `[DECLINED] User declined this action: ${summary}`,
        isError: true,
      },
    };
  }
  return { approved: true, summary };
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
    const out = await tool.handler(tu.input, ctx);
    return { toolUseId: tu.id, content: out, isError: false };
  } catch (err) {
    return {
      toolUseId: tu.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

export async function runAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices>,
): Promise<RunAgentResult> {
  const maxIterations = input.maxIterations ?? 5;
  const tools: ToolMap = new Map(
    input.tools.map((t) => [t.name, t as ToolDef<unknown, unknown>]),
  );
  const toolSchemas: ToolSchema[] = input.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const ctx: ToolContext<TServices> = {
    services: input.services ?? ({} as TServices),
  };

  const messages: Message[] = [...input.messages];
  let iterations = 0;
  let usage = zeroUsage();

  while (iterations < maxIterations) {
    iterations++;

    const res = await input.llm.complete({
      model: input.model,
      system: input.system,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    });

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

    const gates: Array<{ tu: ToolUseBlock; declined?: ToolResultRecord }> = [];
    for (const tu of toolUses) {
      const gate = await gateTool(tu, tools, input.confirm);
      gates.push(gate.approved ? { tu } : { tu, declined: gate.result });
    }

    const results = await Promise.all(
      gates.map((g) =>
        g.declined ? Promise.resolve(g.declined) : runHandler(g.tu, tools, ctx as ToolContext<unknown>),
      ),
    );

    for (const r of results) {
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

export type AgentEvent =
  | StreamEvent
  | { type: "tool_confirm_request"; toolUseId: string; name: string; input: unknown; summary: string }
  | { type: "tool_confirm_response"; toolUseId: string; confirmed: boolean }
  | { type: "tool_dispatch_start"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_dispatch_done"; toolUseId: string; content: string; isError: boolean }
  | { type: "agent_done"; result: RunAgentResult };

export async function* streamAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices> & { signal?: AbortSignal },
): AsyncGenerator<AgentEvent, RunAgentResult, void> {
  const maxIterations = input.maxIterations ?? 5;
  const tools: ToolMap = new Map(
    input.tools.map((t) => [t.name, t as ToolDef<unknown, unknown>]),
  );
  const toolSchemas: ToolSchema[] = input.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const ctx: ToolContext<TServices> = {
    services: input.services ?? ({} as TServices),
  };

  const messages: Message[] = [...input.messages];
  let iterations = 0;
  let usage = zeroUsage();

  while (iterations < maxIterations) {
    iterations++;

    let turnContent: ContentBlock[] = [];
    let turnStop: StopReason = "error";
    let turnUsage: Usage = zeroUsage();

    for await (const ev of input.llm.stream(
      {
        model: input.model,
        system: input.system,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
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

    const gates: Array<{ tu: ToolUseBlock; declined?: ToolResultRecord }> = [];
    for (const tu of toolUses) {
      const tool = tools.get(tu.name);
      if (tool?.requiresConfirmation) {
        const summary = summarizeInput(tool, tu.input);
        yield {
          type: "tool_confirm_request",
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
          summary,
        };
        const gate = await gateTool(tu, tools, input.confirm);
        yield { type: "tool_confirm_response", toolUseId: tu.id, confirmed: gate.approved };
        gates.push(gate.approved ? { tu } : { tu, declined: gate.result });
      } else {
        const gate = await gateTool(tu, tools, input.confirm);
        gates.push(gate.approved ? { tu } : { tu, declined: gate.result });
      }
    }

    for (const g of gates) {
      if (!g.declined) {
        yield { type: "tool_dispatch_start", toolUseId: g.tu.id, name: g.tu.name, input: g.tu.input };
      }
    }

    const results = await Promise.all(
      gates.map((g) =>
        g.declined ? Promise.resolve(g.declined) : runHandler(g.tu, tools, ctx as ToolContext<unknown>),
      ),
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
