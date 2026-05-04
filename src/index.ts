export type { LLMProvider } from "./llm/provider.ts";
export type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  ToolSchema,
  Usage,
} from "./llm/types.ts";
export { anthropic } from "./llm/anthropic.ts";
export { openaiCompat } from "./llm/openai-compat.ts";
export {
  LLMError,
  LLMAuthError,
  LLMRateLimitError,
  LLMBadRequestError,
  LLMServerError,
  LLMTransportError,
  LLMStreamError,
} from "./llm/errors.ts";
export type { LLMErrorCode, ParsedErrorBody, LLMErrorInit } from "./llm/errors.ts";
export { withRetry } from "./llm/retry.ts";
export type { RetryOpts } from "./llm/retry.ts";
export { runAgent, resumeAgent, streamAgent, addUsage, zeroUsage } from "./agent/run.ts";
export type {
  AgentEvent,
  ConfirmCallback,
  ConfirmDecision,
  ConfirmRequest,
  PendingTool,
  ResumeAgentInput,
  ResumeDecision,
  RunAgentInput,
  RunAgentResult,
  RunAgentStopReason,
  SuspensionPayload,
  ToolDef,
  ToolResultRecord,
} from "./agent/run.ts";
export type { ToolContext } from "./agent/context.ts";
export {
  createSpecialist,
  resumeSpecialist,
  runSpecialist,
  streamSpecialist,
} from "./agent/specialist.ts";
export type {
  Specialist,
  RunSpecialistOpts,
  ResumeSpecialistOpts,
} from "./agent/specialist.ts";
export { classifyIntent } from "./agent/router.ts";
export type {
  Intent,
  ClassifyOpts,
  Classification,
  DispatchMode,
} from "./agent/router.ts";
export { tryParseJSON, stripJsonFences } from "./agent/json-repair.ts";
export { orchestrate, resumeOrchestrate, streamOrchestrate } from "./agent/orchestrate.ts";
export type {
  EvaluatorFn,
  EvaluatorInput,
  EvaluatorVerdict,
  OrchestrateOpts,
  OrchestrateResult,
  OrchestrateStreamEvent,
  ResumeOrchestrateOpts,
} from "./agent/orchestrate.ts";
export { inMemoryStore } from "./channel/store.ts";
export type { SessionStore } from "./channel/store.ts";
export { inMemoryPendingStore } from "./channel/pending.ts";
export type { PendingRecord, PendingStore } from "./channel/pending.ts";
export { createChatHandler, createStreamingChatHandler } from "./channel/http.ts";
export type {
  ChatHandler,
  ChatHandlerConfig,
  ChatPending,
  ChatReply,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  StreamingChatHandler,
} from "./channel/http.ts";
export { processUpdate, runPolling, createWebhookHandler } from "./channel/telegram.ts";
export type {
  TelegramUpdate,
  TelegramDeps,
  PollingOpts,
  WebhookOpts,
  WebhookRequest,
  WebhookResponse,
} from "./channel/telegram.ts";
