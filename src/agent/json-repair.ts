/**
 * Lenient JSON parser. Tries strict parse first; on failure, repairs common
 * truncation patterns from local models (lmstudio, etc.):
 * - markdown code fences
 * - trailing commas before truncation
 * - unclosed strings
 * - unclosed `[` / `{`
 *
 * Ported from intrebit/agents/operator/src/claude/router.ts.
 */
export function tryParseJSON(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  const stripped = stripJsonFences(text);
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch {
    // continue to repair
  }

  let s = stripped.trim();
  s = s.replace(/,\s*$/, "");

  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack[stack.length - 1] === ch) {
      stack.pop();
    }
  }

  if (inString) s += '"';
  while (stack.length > 0) s += stack.pop();

  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

export function stripJsonFences(text: string): string {
  let trimmed = text.trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  trimmed = trimmed.replace(/\n?```\s*$/, "");
  return trimmed.trim();
}
