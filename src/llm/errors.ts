export type LLMProviderName = "anthropic" | "openai-compat";

export type LLMErrorCode =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "server"
  | "transport"
  | "stream"
  | "unknown";

export interface ParsedErrorBody {
  type?: string;
  message?: string;
  code?: string;
}

export interface LLMErrorInit {
  provider: LLMProviderName;
  message: string;
  status?: number;
  body?: string;
  parsed?: ParsedErrorBody;
  phase: "request" | "stream";
  cause?: unknown;
}

export class LLMError extends Error {
  readonly code: LLMErrorCode = "unknown";
  readonly provider: LLMProviderName;
  readonly status?: number;
  readonly body?: string;
  readonly parsed?: ParsedErrorBody;
  readonly phase: "request" | "stream";
  constructor(init: LLMErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = this.constructor.name;
    this.provider = init.provider;
    this.status = init.status;
    this.body = init.body;
    this.parsed = init.parsed;
    this.phase = init.phase;
  }
}

export class LLMAuthError extends LLMError {
  override readonly code: LLMErrorCode = "auth";
}

export class LLMRateLimitError extends LLMError {
  override readonly code: LLMErrorCode = "rate_limit";
  readonly retryAfter?: number;
  constructor(init: LLMErrorInit & { retryAfter?: number }) {
    super(init);
    this.retryAfter = init.retryAfter;
  }
}

export class LLMBadRequestError extends LLMError {
  override readonly code: LLMErrorCode = "bad_request";
}

export class LLMServerError extends LLMError {
  override readonly code: LLMErrorCode = "server";
}

export class LLMTransportError extends LLMError {
  override readonly code: LLMErrorCode = "transport";
}

export class LLMStreamError extends LLMError {
  override readonly code: LLMErrorCode = "stream";
}

export function parseErrorBody(
  provider: LLMProviderName,
  body: string,
): ParsedErrorBody | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const root = json as { error?: unknown };
  const err = root.error;
  if (!err || typeof err !== "object") return undefined;
  const e = err as { type?: unknown; message?: unknown; code?: unknown };
  const out: ParsedErrorBody = {};
  if (typeof e.type === "string") out.type = e.type;
  if (typeof e.message === "string") out.message = e.message;
  if (provider === "openai-compat" && typeof e.code === "string") out.code = e.code;
  return Object.keys(out).length > 0 ? out : undefined;
}

interface MinimalResponse {
  status: number;
  headers: Headers;
}

export function errorFromResponse(
  provider: LLMProviderName,
  res: MinimalResponse,
  body: string,
  phase: "request" | "stream",
): LLMError {
  const parsed = parseErrorBody(provider, body);
  const summary = parsed?.message ?? body.slice(0, 200);
  const message = `${provider} ${res.status}: ${summary}`;
  const init: LLMErrorInit = {
    provider,
    message,
    status: res.status,
    body,
    parsed,
    phase,
  };
  const s = res.status;
  if (s === 401 || s === 403) return new LLMAuthError(init);
  if (s === 429) {
    const ra = res.headers.get("retry-after");
    const n = ra ? Number(ra) : NaN;
    const retryAfter = Number.isFinite(n) && n >= 0 ? n : undefined;
    return new LLMRateLimitError({ ...init, retryAfter });
  }
  if (s === 400 || s === 422) return new LLMBadRequestError(init);
  if (s >= 500 && s < 600) return new LLMServerError(init);
  return new LLMError(init);
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown };
  return e.name === "AbortError";
}
