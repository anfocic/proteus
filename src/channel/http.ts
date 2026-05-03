import type { LLMProvider } from "../llm/provider.ts";
import { orchestrate, streamOrchestrate } from "../agent/orchestrate.ts";
import type { Specialist } from "../agent/specialist.ts";
import type { SessionStore } from "./store.ts";

export interface ChatHandlerConfig<TServices> {
  llm: LLMProvider;
  routerModel: string;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  store: SessionStore;
}

export interface ChatRequest {
  sessionId: string;
  message: string;
}

export interface ChatResponse {
  reply: string;
  routedTo: string;
}

export type ChatHandler = (req: ChatRequest) => Promise<ChatResponse>;

export function createChatHandler<TServices>(
  config: ChatHandlerConfig<TServices>,
): ChatHandler {
  return async (req) => {
    const history = await config.store.get(req.sessionId);

    const result = await orchestrate({
      llm: config.llm,
      routerModel: config.routerModel,
      specialistModel: config.specialistModel,
      specialists: config.specialists,
      services: config.services,
      message: req.message,
      history,
    });

    // Only persist the safe-to-re-feed pair (per ADR 0002 + OrchestrateOpts.history caveat).
    // Tool transcripts from the chosen specialist are NOT appended.
    await config.store.append(req.sessionId, [
      { role: "user", content: req.message },
      { role: "assistant", content: [{ type: "text", text: result.finalText }] },
    ]);

    return { reply: result.finalText, routedTo: result.routedTo };
  };
}

export type ChatStreamEvent =
  | { type: "routed"; routedTo: string }
  | { type: "text_delta"; text: string }
  | { type: "done"; reply: string; routedTo: string };

export type StreamingChatHandler = (
  req: ChatRequest,
  opts?: { signal?: AbortSignal },
) => AsyncGenerator<ChatStreamEvent, void, void>;

export function createStreamingChatHandler<TServices>(
  config: ChatHandlerConfig<TServices>,
): StreamingChatHandler {
  return async function* (req, opts) {
    const history = await config.store.get(req.sessionId);

    let routedTo = "";

    for await (const ev of streamOrchestrate({
      llm: config.llm,
      routerModel: config.routerModel,
      specialistModel: config.specialistModel,
      specialists: config.specialists,
      services: config.services,
      message: req.message,
      history,
      signal: opts?.signal,
    })) {
      if (ev.type === "routed") {
        routedTo = ev.routedTo;
        yield { type: "routed", routedTo: ev.routedTo };
      } else if (ev.type === "text_delta") {
        yield { type: "text_delta", text: ev.text };
      } else if (ev.type === "agent_done") {
        const reply = ev.result.finalText;
        // Same persistence rule as buffered handler (ADR 0002): only the
        // user/assistant text pair, never tool transcripts.
        await config.store.append(req.sessionId, [
          { role: "user", content: req.message },
          { role: "assistant", content: [{ type: "text", text: reply }] },
        ]);
        yield { type: "done", reply, routedTo };
        return;
      }
    }
  };
}
