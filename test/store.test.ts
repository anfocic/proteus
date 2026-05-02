import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inMemoryStore } from "../src/index.ts";

test("get on unknown session returns empty array", async () => {
  const s = inMemoryStore();
  assert.deepEqual(await s.get("none"), []);
});

test("append + get round-trips", async () => {
  const s = inMemoryStore();
  await s.append("a", [{ role: "user", content: "hi" }]);
  await s.append("a", [{ role: "user", content: "again" }]);
  const out = await s.get("a");
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { role: "user", content: "again" });
});

test("sessions are isolated", async () => {
  const s = inMemoryStore();
  await s.append("a", [{ role: "user", content: "A" }]);
  await s.append("b", [{ role: "user", content: "B" }]);
  assert.equal((await s.get("a")).length, 1);
  assert.equal((await s.get("b")).length, 1);
});

test("get returns a copy — caller mutation does not corrupt store", async () => {
  const s = inMemoryStore();
  await s.append("a", [{ role: "user", content: "x" }]);
  const got = await s.get("a");
  got.push({ role: "user", content: "INJECTED" });
  const fresh = await s.get("a");
  assert.equal(fresh.length, 1);
});

test("concurrent appends to same session do not lose writes", async () => {
  const s = inMemoryStore();
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      s.append("a", [{ role: "user", content: String(i) }]),
    ),
  );
  const out = await s.get("a");
  assert.equal(out.length, N);
  // serialization preserves submission order under in-process Promise scheduling
  for (let i = 0; i < N; i++) {
    assert.equal((out[i] as { content: string }).content, String(i));
  }
});
