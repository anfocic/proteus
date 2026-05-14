import { timingSafeEqual } from "node:crypto";
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

export interface WebhookOpts extends TelegramDeps {
  secretToken?: string;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined> | { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface WebhookResponse {
  status: number;
  body?: string;
}

function api(deps: TelegramDeps, method: string): string {
  const base = (deps.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}/bot${deps.token}/${method}`;
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return text.slice(0, MAX_TEXT - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function reportError(deps: TelegramDeps, err: unknown, update?: TelegramUpdate): void {
  // The bot token sits in every API URL; Node's fetch-rejection errors can
  // echo the URL back in their message. Redact before it reaches a logger.
  if (deps.token && err instanceof Error && err.message.includes(deps.token)) {
    err.message = err.message.replaceAll(deps.token, "<token>");
  }
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
    const replyText =
      result.kind === "reply"
        ? result.reply
        : `Action requires confirmation: ${result.summary}`;
    const text = truncate(replyText);

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

function readHeader(headers: WebhookRequest["headers"], name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const h = headers as Record<string, string | undefined>;
  return h[name] ?? h[name.toLowerCase()];
}

export function createWebhookHandler(
  opts: WebhookOpts,
): (req: WebhookRequest) => Promise<WebhookResponse> {
  return async (req) => {
    if (opts.secretToken) {
      const got = readHeader(req.headers, "x-telegram-bot-api-secret-token");
      if (got === undefined || !constantTimeEqual(got, opts.secretToken)) {
        return { status: 401 };
      }
    }
    let update: TelegramUpdate;
    try {
      update = (await req.json()) as TelegramUpdate;
    } catch (err) {
      reportError(opts, err);
      return { status: 400 };
    }
    await processUpdate(update, opts);
    return { status: 200 };
  };
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
