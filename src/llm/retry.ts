import type { LLMProvider } from "./provider.ts";
import type { CompletionRequest, CompletionResponse, StreamEvent } from "./types.ts";
import {
  isAbortError,
  LLMError,
  LLMRateLimitError,
  LLMServerError,
  LLMTransportError,
} from "./errors.ts";

export interface RetryOpts {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
  onRetry?: (info: { error: LLMError; attempt: number; delayMs: number }) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface ResolvedOpts {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  jitter: boolean;
  onRetry?: RetryOpts["onRetry"];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function resolve(opts: RetryOpts): ResolvedOpts {
  return {
    maxAttempts: opts.maxAttempts ?? 3,
    baseMs: opts.baseMs ?? 500,
    maxMs: opts.maxMs ?? 30_000,
    jitter: opts.jitter ?? true,
    onRetry: opts.onRetry,
    sleep: opts.sleep ?? defaultSleep,
  };
}

function isRetryable(err: unknown): err is LLMError {
  if (isAbortError(err)) return false;
  return (
    err instanceof LLMRateLimitError ||
    err instanceof LLMServerError ||
    err instanceof LLMTransportError
  );
}

function computeDelay(err: LLMError, attempt: number, opts: ResolvedOpts): number {
  if (err instanceof LLMRateLimitError && err.retryAfter !== undefined) {
    return Math.min(opts.maxMs, err.retryAfter * 1000);
  }
  const exp = opts.baseMs * 2 ** (attempt - 1);
  const capped = Math.min(opts.maxMs, exp);
  if (!opts.jitter) return capped;
  return Math.floor(Math.random() * capped);
}

export function withRetry(llm: LLMProvider, opts: RetryOpts = {}): LLMProvider {
  const o = resolve(opts);

  const complete = async (
    req: CompletionRequest,
    completeOpts?: { signal?: AbortSignal },
  ): Promise<CompletionResponse> => {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        return await llm.complete(req, completeOpts);
      } catch (err) {
        if (!isRetryable(err) || attempt >= o.maxAttempts) throw err;
        const delayMs = computeDelay(err, attempt, o);
        o.onRetry?.({ error: err, attempt, delayMs });
        await o.sleep(delayMs, completeOpts?.signal);
      }
    }
  };

  async function* stream(
    req: CompletionRequest,
    streamOpts?: { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, void> {
    let attempt = 0;
    while (true) {
      attempt++;
      const iter = llm.stream(req, streamOpts);
      let yielded = false;
      try {
        for (;;) {
          const next = await iter.next();
          if (next.done) return;
          yielded = true;
          yield next.value;
        }
      } catch (err) {
        // The failed generator is abandoned here — close it so any open
        // connection/reader from a pre-yield failure is released before the
        // next attempt opens a new one.
        await iter.return?.(undefined).catch(() => {});
        if (yielded || !isRetryable(err) || attempt >= o.maxAttempts) throw err;
        const delayMs = computeDelay(err, attempt, o);
        o.onRetry?.({ error: err, attempt, delayMs });
        await o.sleep(delayMs, streamOpts?.signal);
      }
    }
  }

  return { complete, stream };
}
