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
}

export interface RunAgentInput<TServices = Record<string, unknown>> {
  llm: LLMProvider;
  model: string;
  system?: string;
  tools: ToolDef<unknown, TServices>[];
  messages: Message[];
  services?: TServices;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface RunAgentResult {
  messages: Message[];
  finalText: string;
  iterations: number;
  stopReason: "end_turn" | "max_iterations" | "max_tokens" | "error";
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolHandler = (input: unknown, ctx: ToolContext<unknown>) => Promise<string> | string;
type ToolResultRecord = { toolUseId: string; content: string; isError: boolean };

export async function runAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices>,
): Promise<RunAgentResult> {
  const maxIterations = input.maxIterations ?? 5;
  const handlers = new Map(input.tools.map((t) => [t.name, t.handler as ToolHandler]));
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

    messages.push({ role: "assistant", content: res.content });

    if (res.stopReason !== "tool_use") {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: res.stopReason,
      };
    }

    const toolUses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "end_turn",
      };
    }

    const results = await Promise.all(
      toolUses.map((tu) => dispatchTool(tu, handlers, ctx as ToolContext<unknown>)),
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
  return { messages, finalText, iterations, stopReason: "max_iterations" };
}

export type AgentEvent =
  | StreamEvent
  | { type: "tool_dispatch_start"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_dispatch_done"; toolUseId: string; content: string; isError: boolean }
  | { type: "agent_done"; result: RunAgentResult };

export async function* streamAgent<TServices = Record<string, unknown>>(
  input: RunAgentInput<TServices> & { signal?: AbortSignal },
): AsyncGenerator<AgentEvent, RunAgentResult, void> {
  const maxIterations = input.maxIterations ?? 5;
  const handlers = new Map(input.tools.map((t) => [t.name, t.handler as ToolHandler]));
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

  while (iterations < maxIterations) {
    iterations++;

    let turnContent: ContentBlock[] = [];
    let turnStop: StopReason = "error";
    let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };

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
    void turnUsage;

    messages.push({ role: "assistant", content: turnContent });

    if (turnStop !== "tool_use") {
      const result: RunAgentResult = {
        messages,
        finalText: extractText(turnContent),
        iterations,
        stopReason: turnStop,
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
      };
      yield { type: "agent_done", result };
      return result;
    }

    for (const tu of toolUses) {
      yield { type: "tool_dispatch_start", toolUseId: tu.id, name: tu.name, input: tu.input };
    }

    const results = await Promise.all(
      toolUses.map((tu) => dispatchTool(tu, handlers, ctx as ToolContext<unknown>)),
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
  };
  yield { type: "agent_done", result };
  return result;
}

async function dispatchTool(
  tu: ToolUseBlock,
  handlers: Map<string, ToolHandler>,
  ctx: ToolContext<unknown>,
): Promise<ToolResultRecord> {
  const handler = handlers.get(tu.name);
  if (!handler) {
    return { toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true };
  }
  try {
    const out = await handler(tu.input, ctx);
    return { toolUseId: tu.id, content: out, isError: false };
  } catch (err) {
    return {
      toolUseId: tu.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}
