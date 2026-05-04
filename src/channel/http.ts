import type { LLMProvider } from "../llm/provider.ts";
import {
  orchestrate,
  resumeOrchestrate,
  streamOrchestrate,
} from "../agent/orchestrate.ts";
import type { EvaluatorFn } from "../agent/orchestrate.ts";
import type { ConfirmCallback } from "../agent/run.ts";
import type { Specialist } from "../agent/specialist.ts";
import type { PendingStore } from "./pending.ts";
import type { SessionStore } from "./store.ts";

export interface ChatHandlerConfig<TServices> {
  llm: LLMProvider;
  routerModel: string;
  specialistModel: string;
  specialists: Specialist<TServices>[];
  services: TServices;
  store: SessionStore;
  confirm?: ConfirmCallback;
  /**
   * Optional. When set, tools marked `requiresConfirmation: true` suspend
   * the agent loop on first encounter, persist a pending record keyed by
   * `sessionId`, and return a `{ kind: "pending" }` response. The next
   * request must carry `confirm: { decision }` to resume.
   *
   * When unset (default), the in-process `confirm` callback is used and any
   * unresolved confirmation surfaces as an error tool_result (as before).
   */
  pendingStore?: PendingStore;
  /**
   * Optional quality gate. Threads to `orchestrate` on the buffered handler
   * only — `createStreamingChatHandler` does not support evaluators.
   */
  evaluate?: EvaluatorFn;
  maxEvaluatorAttempts?: number;
}

export interface ChatRequest {
  sessionId: string;
  message?: string;
  confirm?: { decision: "approve" | "decline" };
}

export interface ChatReply {
  kind: "reply";
  reply: string;
  routedTo: string;
}

export interface ChatPending {
  kind: "pending";
  routedTo: string;
  toolUseId: string;
  name: string;
  summary: string;
}

export type ChatResponse = ChatReply | ChatPending;

export type ChatHandler = (req: ChatRequest) => Promise<ChatResponse>;

export function createChatHandler<TServices>(
  config: ChatHandlerConfig<TServices>,
): ChatHandler {
  return async (req) => {
    if (config.pendingStore) {
      const existing = await config.pendingStore.get(req.sessionId);
      if (existing) {
        if (!req.confirm) {
          const p = existing.suspended.pending;
          return {
            kind: "pending",
            routedTo: existing.routedTo,
            toolUseId: p.toolUseId,
            name: p.name,
            summary: p.summary,
          };
        }
        const result = await resumeOrchestrate({
          llm: config.llm,
          specialistModel: config.specialistModel,
          specialists: config.specialists,
          services: config.services,
          routedTo: existing.routedTo,
          suspended: existing.suspended,
          resume: {
            toolUseId: existing.suspended.pending.toolUseId,
            decision: req.confirm.decision,
          },
          confirm: pendingConfirm,
        });
        if (result.suspended) {
          await config.pendingStore.set(req.sessionId, {
            routedTo: result.routedTo,
            suspended: result.suspended,
          });
          const p = result.suspended.pending;
          return {
            kind: "pending",
            routedTo: result.routedTo,
            toolUseId: p.toolUseId,
            name: p.name,
            summary: p.summary,
          };
        }
        await config.pendingStore.clear(req.sessionId);
        await config.store.append(req.sessionId, [
          { role: "assistant", content: [{ type: "text", text: result.finalText }] },
        ]);
        return { kind: "reply", reply: result.finalText, routedTo: result.routedTo };
      }
    }

    if (!req.message) {
      throw new Error("ChatRequest.message is required when no pending action exists");
    }

    const history = await config.store.get(req.sessionId);
    const confirm = config.pendingStore ? pendingConfirm : config.confirm;

    const result = await orchestrate({
      llm: config.llm,
      routerModel: config.routerModel,
      specialistModel: config.specialistModel,
      specialists: config.specialists,
      services: config.services,
      message: req.message,
      history,
      confirm,
      evaluate: config.evaluate,
      maxEvaluatorAttempts: config.maxEvaluatorAttempts,
    });

    await config.store.append(req.sessionId, [{ role: "user", content: req.message }]);

    if (result.suspended && config.pendingStore) {
      await config.pendingStore.set(req.sessionId, {
        routedTo: result.routedTo,
        suspended: result.suspended,
      });
      const p = result.suspended.pending;
      return {
        kind: "pending",
        routedTo: result.routedTo,
        toolUseId: p.toolUseId,
        name: p.name,
        summary: p.summary,
      };
    }

    await config.store.append(req.sessionId, [
      { role: "assistant", content: [{ type: "text", text: result.finalText }] },
    ]);

    return { kind: "reply", reply: result.finalText, routedTo: result.routedTo };
  };
}

const pendingConfirm: ConfirmCallback = async () => "pending";

export type ChatStreamEvent =
  | { type: "routed"; routedTo: string }
  | { type: "text_delta"; text: string }
  | { type: "done"; reply: string; routedTo: string };

export type StreamingChatHandler = (
  req: { sessionId: string; message: string },
  opts?: { signal?: AbortSignal },
) => AsyncGenerator<ChatStreamEvent, void, void>;

export function createStreamingChatHandler<TServices>(
  config: Omit<ChatHandlerConfig<TServices>, "pendingStore" | "evaluate" | "maxEvaluatorAttempts">,
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
      confirm: config.confirm,
      signal: opts?.signal,
    })) {
      if (ev.type === "routed") {
        routedTo = ev.routedTo;
        yield { type: "routed", routedTo: ev.routedTo };
      } else if (ev.type === "text_delta") {
        yield { type: "text_delta", text: ev.text };
      } else if (ev.type === "agent_done") {
        const reply = ev.result.finalText;
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
