import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSSE, type SSERecord } from "../src/llm/sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<SSERecord[]> {
  const out: SSERecord[] = [];
  for await (const r of parseSSE(body, signal)) out.push(r);
  return out;
}

test("parses Anthropic-style named events", async () => {
  const body = streamOf(
    "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"text_delta\"}\n\n",
  );
  const got = await drain(body);
  assert.deepEqual(got, [
    { event: "message_start", data: '{"type":"message_start"}' },
    { event: "content_block_delta", data: '{"type":"text_delta"}' },
  ]);
});

test("parses OpenAI-style anonymous events", async () => {
  const body = streamOf('data: {"choices":[{}]}\n\ndata: [DONE]\n\n');
  const got = await drain(body);
  assert.deepEqual(got, [{ data: '{"choices":[{}]}' }, { data: "[DONE]" }]);
});

test("joins multi-line data with newline", async () => {
  const body = streamOf("data: line1\ndata: line2\n\n");
  const got = await drain(body);
  assert.deepEqual(got, [{ data: "line1\nline2" }]);
});

test("reassembles event split across chunks", async () => {
  const body = streamOf("event: foo\nda", 'ta: {"a":1}\n\n');
  const got = await drain(body);
  assert.deepEqual(got, [{ event: "foo", data: '{"a":1}' }]);
});

test("ignores comments, blanks, unknown fields", async () => {
  const body = streamOf(": this is a comment\nid: 42\nretry: 100\nevent: ping\ndata: ok\n\n");
  const got = await drain(body);
  assert.deepEqual(got, [{ event: "ping", data: "ok" }]);
});

test("skips records with no data field", async () => {
  const body = streamOf("event: heartbeat\n\ndata: real\n\n");
  const got = await drain(body);
  assert.deepEqual(got, [{ data: "real" }]);
});

test("handles CRLF line endings", async () => {
  const body = streamOf("event: hi\r\ndata: world\r\n\r\n");
  const got = await drain(body);
  assert.deepEqual(got, [{ event: "hi", data: "world" }]);
});

test("emits trailing record without final blank line", async () => {
  const body = streamOf("data: tail");
  const got = await drain(body);
  assert.deepEqual(got, [{ data: "tail" }]);
});

test("aborts mid-stream", async () => {
  const ctrl = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode("data: one\n\n"));
      // never close — abort below
    },
  });

  const it = parseSSE(body, ctrl.signal);
  const first = await it.next();
  assert.deepEqual(first.value, { data: "one" });

  ctrl.abort();
  await assert.rejects(() => it.next(), (e: Error) => e.name === "AbortError");
});
