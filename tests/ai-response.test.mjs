import test from "node:test";
import assert from "node:assert/strict";
import { parseNoteSearchResponse } from "../api/ai-response.js";

const answer = { answer: "Add folders and a better search experience.", sources: [{ id: "note-1", title: "Ideas", excerpt: "Better search" }] };

test("parses normal Gemini JSON into answer and sources", () => {
  assert.deepEqual(parseNoteSearchResponse(JSON.stringify(answer)), answer);
});

test("parses fenced and double-encoded JSON", () => {
  assert.deepEqual(parseNoteSearchResponse(JSON.stringify(JSON.stringify(answer))), answer);
});

test("rejects truncated JSON rather than displaying it", () => {
  assert.throws(() => parseNoteSearchResponse('{"answer":"Incomplete","sources":['), /invalid JSON/);
});

test("rejects objects with no readable answer", () => {
  assert.throws(() => parseNoteSearchResponse('{"sources":[]}'), /without an answer/);
});

test("rejects invalid sources instead of showing them as text", () => {
  assert.throws(() => parseNoteSearchResponse('{"answer":"OK","sources":"not an array"}'), /invalid note sources/);
});
