import type { ChatHandler } from "./http.ts";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const MAX_TEXT = 4000;
const TRUNC_SUFFIX = "…[truncated]";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
    from?: { id: number; username?: string };
    text?: string;
  };
}

export interface TelegramDeps {
  token: string;
  handler: ChatHandler;
  baseURL?: string;
  fetch?: typeof fetch;
  onError?: (err: unknown, ctx: { update?: TelegramUpdate }) => void;
}

export interface PollingOpts extends TelegramDeps {
  signal?: AbortSignal;
  pollTimeout?: number;
}

function api(deps: TelegramDeps, method: string): string {
  const base = (deps.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}/bot${deps.token}/${method}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return text.slice(0, MAX_TEXT - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
}

function reportError(deps: TelegramDeps, err: unknown, update?: TelegramUpdate): void {
  const onError = deps.onError ?? ((e) => console.error("[telegram]", e));
  try {
    onError(err, { update });
  } catch {
    // swallow — never crash poll loop on user-supplied error reporter
  }
}

export async function processUpdate(
  update: TelegramUpdate,
  deps: TelegramDeps,
): Promise<void> {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string" || !msg.chat) return;

  const sessionId = String(msg.chat.id);
  const fetchImpl = deps.fetch ?? fetch;

  try {
    const result = await deps.handler({ sessionId, message: msg.text });
    const text = truncate(result.reply);

    const res = await fetchImpl(api(deps, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`telegram sendMessage ${res.status}: ${body}`);
    }
  } catch (err) {
    reportError(deps, err, update);
  }
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

export async function runPolling(opts: PollingOpts): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const pollTimeout = opts.pollTimeout ?? 25;
  let offset = 0;
  let backoff = 1000;
  const MAX_BACKOFF = 5000;

  while (!opts.signal?.aborted) {
    let payload: GetUpdatesResponse;
    try {
      const url = `${api(opts, "getUpdates")}?offset=${offset}&timeout=${pollTimeout}`;
      const res = await fetchImpl(url, { signal: opts.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`telegram getUpdates ${res.status}: ${body}`);
      }
      payload = (await res.json()) as GetUpdatesResponse;
      backoff = 1000;
    } catch (err) {
      if (opts.signal?.aborted) return;
      reportError(opts, err);
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }

    const updates = payload.result ?? [];
    for (const update of updates) {
      if (opts.signal?.aborted) return;
      await processUpdate(update, opts);
      if (update.update_id >= offset) offset = update.update_id + 1;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
