import { createInterface } from "node:readline/promises";
import {
  anthropic,
  createSpecialist,
  openaiCompat,
  orchestrate,
  type ConfirmCallback,
  type LLMProvider,
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

const fileops = createSpecialist({
  name: "fileops",
  description: "File operations: deleting, moving, or modifying files on disk.",
  role: "You handle file operations using the delete_file tool. Be brief.",
  tools: [
    {
      name: "delete_file",
      description: "Delete a file at the given absolute or relative path.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      requiresConfirmation: true,
      summarize: (input) => `Delete file: ${(input as { path: string }).path}`,
      handler: async (input) => {
        const { path } = input as { path: string };
        return `(pretend) deleted ${path}`;
      },
    },
  ],
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

const confirm: ConfirmCallback = async (req) => {
  const ans = await rl.question(`\n[CONFIRM] ${req.summary} (y/N)? `);
  return ans.trim().toLowerCase() === "y";
};

const message = process.argv[2] ?? "delete the file ./scratch.txt";

try {
  const result = await orchestrate({
    llm,
    routerModel: model,
    specialistModel: model,
    specialists: [fileops],
    services: {},
    message,
    confirm,
  });
  console.log(`\n[routed to: ${result.routedTo}] ${result.finalText}`);
} finally {
  rl.close();
}
