import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tryParseJSON, stripJsonFences } from "../src/agent/json-repair.ts";

test("strict valid JSON parses", () => {
  const r = tryParseJSON('{"a": 1, "b": "x"}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1, b: "x" });
});

test("trailing comma before truncation is repaired", () => {
  const r = tryParseJSON('{"a": 1,');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("unclosed string gets closing quote", () => {
  const r = tryParseJSON('{"a": "hello');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: "hello" });
});

test("unclosed brace gets closer", () => {
  const r = tryParseJSON('{"a": 1, "b": 2');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1, b: 2 });
});

test("unclosed bracket gets closer", () => {
  const r = tryParseJSON('{"xs": [1, 2, 3');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { xs: [1, 2, 3] });
});

test("nested unclosed bracket + brace", () => {
  const r = tryParseJSON('{"xs": [1, {"a": "y');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { xs: [1, { a: "y" }] });
});

test("markdown json fence stripped", () => {
  const r = tryParseJSON('```json\n{"a": 1}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("plain markdown fence stripped", () => {
  const r = tryParseJSON('```\n{"a": 1}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("escaped quote does not terminate string", () => {
  const r = tryParseJSON('{"a": "he said \\"hi\\""}');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 'he said "hi"' });
});

test("brace inside string does not affect depth tracking", () => {
  const r = tryParseJSON('{"a": "}}}", "b": 2');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: "}}}", b: 2 });
});

test("totally broken returns ok:false", () => {
  const r = tryParseJSON("not json at all just words");
  assert.equal(r.ok, false);
});

test("empty string returns ok:false", () => {
  const r = tryParseJSON("");
  assert.equal(r.ok, false);
});

test("stripJsonFences handles no fence (passthrough)", () => {
  assert.equal(stripJsonFences('{"a":1}'), '{"a":1}');
});
