import type { LLMProvider } from "../llm/provider.ts";
import { orchestrate } from "../agent/orchestrate.ts";
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
