import { strict as assert } from "node:assert";
import { test } from "node:test";
import { trimToBudget, estimateMessageCost, type Tokenize } from "../src/index.ts";
import type { Message } from "../src/llm/types.ts";

// Simple char-count tokenize (1 token per character) for predictable math.
const charTokens: Tokenize = (s) => s.length;

const u = (content: string): Message => ({ role: "user", content });
const a = (content: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
});
const tr = (id: string, content: string): Message => ({
  role: "tool_result",
  toolUseId: id,
  content,
  isError: false,
});

test("empty messages → empty result", () => {
  assert.deepEqual(
    trimToBudget({ messages: [], maxTokens: 100, tokenize: charTokens }),
    [],
  );
});

test("under budget → no trim", () => {
  const msgs = [u("hi"), a("hello"), u("how are you")];
  // total = 2+5+11 + 3*3 (overhead) = 27. Budget 100 fits.
  const out = trimToBudget({ messages: msgs, maxTokens: 100, tokenize: charTokens });
  assert.deepEqual(out, msgs);
});

test("trims oldest messages first to fit budget", () => {
  // Costs (with overhead 3): u(10)=13, a(20)=23, u(5)=8. total=44.
  const msgs = [u("x".repeat(10)), a("y".repeat(20)), u("z".repeat(5))];
  const out = trimToBudget({ messages: msgs, maxTokens: 35, tokenize: charTokens });
  // Walking newest→oldest: keep z(8 cum), keep a(8+23=31 cum), reject u (44>35).
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "assistant");
  assert.equal((out[1] as { content: string }).content, "z".repeat(5));
});

test("preserveLast default 1 → keeps most recent even if oversized", () => {
  const msgs = [u("ok"), a("ok"), u("x".repeat(10000))];
  const out = trimToBudget({ messages: msgs, maxTokens: 50, tokenize: charTokens });
  assert.equal(out.length, 1);
  assert.equal((out[0] as { content: string }).content, "x".repeat(10000));
});

test("preserveLast=2 keeps last two regardless of budget", () => {
  const msgs = [
    u("oldest"),
    a("middle"),
    u("x".repeat(500)),
    a("y".repeat(500)),
  ];
  const out = trimToBudget({
    messages: msgs,
    maxTokens: 10,
    tokenize: charTokens,
    preserveLast: 2,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
});

test("tool_result message cost uses content length", () => {
  const msg = tr("u1", "x".repeat(100));
  assert.equal(estimateMessageCost(msg, charTokens), 100);
});

test("assistant content blocks: sums text + reasoning + JSON-stringified tool_use input", () => {
  const msg: Message = {
    role: "assistant",
    content: [
      { type: "text", text: "abc" },
      { type: "reasoning", text: "xy" },
      { type: "tool_use", id: "u1", name: "t", input: { a: 1 } },
    ],
  };
  // text=3, reasoning=2, JSON.stringify({a:1})="{\"a\":1}" = 7. total=12.
  assert.equal(estimateMessageCost(msg, charTokens), 12);
});

test("does not mutate input array", () => {
  const msgs = [u("a"), u("b"), u("c")];
  const before = [...msgs];
  trimToBudget({ messages: msgs, maxTokens: 10, tokenize: charTokens });
  assert.deepEqual(msgs, before);
});

test("custom perMessageOverhead is respected", () => {
  const msgs = [u("x".repeat(10)), u("y".repeat(10))];
  // overhead=0 → costs are 10+10=20. budget 15 keeps last only.
  const out = trimToBudget({
    messages: msgs,
    maxTokens: 15,
    tokenize: charTokens,
    perMessageOverhead: 0,
  });
  assert.equal(out.length, 1);
  assert.equal((out[0] as { content: string }).content, "y".repeat(10));
});
