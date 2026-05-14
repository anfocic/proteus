import type { CompletionRequest, CompletionResponse, StreamEvent } from "./types.ts";

export interface LLMProvider {
  complete(
    req: CompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<CompletionResponse>;
  stream(
    req: CompletionRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, void>;
}
