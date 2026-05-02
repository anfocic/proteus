import type { LLMProvider } from "../llm/provider.ts";
import type { ContentBlock, Message, ToolSchema } from "../llm/types.ts";

export interface ToolDef extends ToolSchema {
  handler: (input: unknown) => Promise<string> | string;
}

export interface RunAgentInput {
  llm: LLMProvider;
  model: string;
  system?: string;
  tools: ToolDef[];
  messages: Message[];
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

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const maxIterations = input.maxIterations ?? 5;
  const handlers = new Map(input.tools.map((t) => [t.name, t.handler]));
  const toolSchemas: ToolSchema[] = input.tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

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

    if (res.stopReason === "end_turn") {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "end_turn",
      };
    }

    if (res.stopReason === "max_tokens") {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "max_tokens",
      };
    }

    if (res.stopReason === "error") {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "error",
      };
    }

    // stopReason === "tool_use"
    const toolUses = res.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }>;

    if (toolUses.length === 0) {
      return {
        messages,
        finalText: extractText(res.content),
        iterations,
        stopReason: "end_turn",
      };
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const handler = handlers.get(tu.name);
        if (!handler) {
          return { toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true };
        }
        try {
          const out = await handler(tu.input);
          return { toolUseId: tu.id, content: out, isError: false };
        } catch (err) {
          return {
            toolUseId: tu.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }),
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

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}
