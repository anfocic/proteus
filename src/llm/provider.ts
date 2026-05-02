import type { CompletionRequest, CompletionResponse } from "./types.ts";

export interface LLMProvider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
