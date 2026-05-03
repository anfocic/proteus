import {
  anthropic,
  createSpecialist,
  openaiCompat,
  orchestrate,
  type ConfirmCallback,
  type LLMProvider,
  type Message,
} from "../src/index.ts";

const provider = process.env.PROVIDER ?? "compat";

let llm: LLMProvider;
let model: string;

if (provider === "anthropic") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  llm = anthropic({ apiKey });
  model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
} else if (provider === "compat") {
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL;
  if (!apiKey) throw new Error("LLM_API_KEY not set");
  if (!baseURL) throw new Error("LLM_BASE_URL not set");
  llm = openaiCompat({ apiKey, baseURL });
  model = process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";
} else {
  throw new Error(`unknown provider: ${provider}`);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

const fileops = createSpecialist({
  name: "fileops",
  description: "Deleting, moving, or modifying files. Any destructive file action.",
  role: "Handle file operations using the delete_file tool. Be brief.",
  tools: [
    {
      name: "delete_file",
      description: "Delete a file at the given path.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      requiresConfirmation: true,
      summarize: (input) => `Delete file: ${(input as { path: string }).path}`,
      handler: async (input) => `(pretend) deleted ${(input as { path: string }).path}`,
    },
  ],
});

async function tg<T = unknown>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
  return json.result;
}

// Per-chat session state — history + pending confirms keyed by toolUseId.
interface ChatState {
  history: Message[];
  pending: Map<string, (ok: boolean) => void>;
}
const chats = new Map<number, ChatState>();
const getChat = (id: number): ChatState =>
  chats.get(id) ?? (chats.set(id, { history: [], pending: new Map() }), chats.get(id)!);

const confirmFor = (chatId: number): ConfirmCallback => async (req) => {
  const state = getChat(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Confirm: ${req.summary}`,
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `y:${req.toolUseId}` },
        { text: "Decline", callback_data: `n:${req.toolUseId}` },
      ]],
    },
  });
  return new Promise<boolean>((resolve) => state.pending.set(req.toolUseId, resolve));
};

async function handleMessage(chatId: number, textIn: string): Promise<void> {
  const state = getChat(chatId);
  const result = await orchestrate({
    llm,
    routerModel: model,
    specialistModel: model,
    specialists: [fileops],
    services: {},
    message: textIn,
    history: state.history,
    confirm: confirmFor(chatId),
  });
  state.history.push(
    { role: "user", content: textIn },
    { role: "assistant", content: [{ type: "text", text: result.finalText }] },
  );
  await tg("sendMessage", { chat_id: chatId, text: result.finalText });
}

function handleCallback(chatId: number, data: string, callbackQueryId: string): void {
  const [verdict, toolUseId] = data.split(":", 2);
  const state = getChat(chatId);
  const resolve = state.pending.get(toolUseId ?? "");
  if (resolve) {
    state.pending.delete(toolUseId!);
    resolve(verdict === "y");
  }
  void tg("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

interface RawUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

const ctrl = new AbortController();
process.on("SIGINT", () => {
  console.log("\nshutting down...");
  ctrl.abort();
});

console.log(`telegram-confirm bot up (provider=${provider}, model=${model}) — Ctrl-C to exit`);

let offset = 0;
while (!ctrl.signal.aborted) {
  let updates: RawUpdate[] = [];
  try {
    updates = await tg<RawUpdate[]>("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });
  } catch (err) {
    if (ctrl.signal.aborted) break;
    console.error("[telegram] poll err:", err);
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  for (const u of updates) {
    offset = Math.max(offset, u.update_id + 1);
    try {
      if (u.message?.text) {
        void handleMessage(u.message.chat.id, u.message.text);
      } else if (u.callback_query?.data && u.callback_query.message) {
        handleCallback(u.callback_query.message.chat.id, u.callback_query.data, u.callback_query.id);
      }
    } catch (err) {
      console.error("[telegram] handle err:", err);
    }
  }
}

console.log("telegram-confirm bot stopped");
