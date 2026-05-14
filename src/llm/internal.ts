import { parseSSE, type SSERecord } from "./sse.ts";
import type { StreamEvent } from "./types.ts";
import {
  errorFromResponse,
  isAbortError,
  LLMStreamError,
  LLMTransportError,
  type LLMProviderName,
} from "./errors.ts";

/**
 * Drop `undefined`-valued keys so they don't serialize as `null` / absent-but-
 * present. Both adapters strip their request body before `JSON.stringify`.
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface ProviderStreamArgs {
  provider: LLMProviderName;
  /** Human-readable prefix for error messages, e.g. "Anthropic" / "OpenAI". */
  label: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  transform: (records: AsyncIterable<SSERecord>) => AsyncGenerator<StreamEvent, void, void>;
}

/**
 * Shared streaming scaffold for both adapters: abort wiring, the POST, the
 * `!res.ok` / `!res.body` guards, and the parse-and-transform pipe with its
 * error-normalization and cleanup. The only adapter-specific piece is
 * `transform` — the SSE-payload → `StreamEvent` generator.
 */
export async function* runProviderStream(
  args: ProviderStreamArgs,
): AsyncGenerator<StreamEvent, void, void> {
  const { provider, label, url, headers, body, signal, transform } = args;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    signal?.removeEventListener("abort", onAbort);
    if (isAbortError(e)) throw e;
    throw new LLMTransportError({
      provider,
      message: `${label} stream: transport failure during request`,
      phase: "stream",
      cause: e,
    });
  }

  if (!res.ok) {
    const text = await res.text();
    signal?.removeEventListener("abort", onAbort);
    throw errorFromResponse(provider, res, text, "stream");
  }
  if (!res.body) {
    signal?.removeEventListener("abort", onAbort);
    throw new LLMStreamError({
      provider,
      message: `${label} stream: response has no body`,
      phase: "stream",
    });
  }

  try {
    yield* transform(parseSSE(res.body, ctrl.signal));
  } catch (e) {
    if (isAbortError(e)) throw e;
    if (e instanceof LLMTransportError || e instanceof LLMStreamError) throw e;
    throw new LLMTransportError({
      provider,
      message: `${label} stream: transport failure mid-stream`,
      phase: "stream",
      cause: e,
    });
  } finally {
    ctrl.abort();
    signal?.removeEventListener("abort", onAbort);
  }
}
