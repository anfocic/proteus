import type { CompletionRequest, CompletionResponse, StreamEvent } from "./types.ts";

export interface LLMProvider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  stream(
    req: CompletionRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, void>;
}
