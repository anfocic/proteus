export interface SSERecord {
  event?: string;
  data: string;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSERecord, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }

      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = indexOfDelim(buf)) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + delimLen(buf, sep));
        const rec = parseRecord(raw);
        if (rec) yield rec;
      }
    }
    // Trailing buffer without final blank line — treat as a complete record if non-empty.
    const tail = buf.trim();
    if (tail) {
      const rec = parseRecord(tail);
      if (rec) yield rec;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function indexOfDelim(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function delimLen(s: string, at: number): number {
  return s.startsWith("\r\n\r\n", at) ? 4 : 2;
}

function parseRecord(raw: string): SSERecord | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // id, retry, unknown fields ignored
  }

  if (dataLines.length === 0) return null;
  const rec: SSERecord = { data: dataLines.join("\n") };
  if (event !== undefined) rec.event = event;
  return rec;
}
