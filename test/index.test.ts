import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { AlignmentMonitor, check, parseTranscript, loadState, saveState, jaccard, tokenize, type Anchor } from "../src/index.js";

const anchor: Anchor = { goals: ["build TypeScript drift detection package"], constraints: ["never use emojis or python"], persona: "Taloose, friendly", decisions: ["repository stays private"] };

test("on-topic turn is not drift", async () => {
  const r = await check(anchor, [{ role: "user", content: "start the package" }, { role: "assistant", content: "I'll build the TypeScript drift detection package now." }]);
  assert.deepEqual(r.driftPoints, []); assert.equal(r.realignment, null);
});
test("constraint violation + topic shift flags drift", async () => {
  const r = await check(anchor, [{ role: "user", content: "build the package" }, { role: "assistant", content: "Here is a python recipe for banana bread with lots of emojis and sugar today." }]);
  assert.deepEqual(r.driftPoints, [1]);
  assert.ok(r.turns[1].reasons.some(x => x.kind === "constraint"));
  assert.match(r.realignment!, /\[REALIGN\]/);
});
test("contradicting a decision is detected", () => {
  const m = new AlignmentMonitor(anchor);
  const r = m.scoreTurn({ role: "assistant", content: "Actually, let's switch to making the repository public instead for the package." });
  assert.ok(r.reasons.some(x => x.kind === "decision"));
});
test("persona drift", () => {
  const r = new AlignmentMonitor(anchor).scoreTurn({ role: "assistant", content: "Hi, I'm Grokbert and I build TypeScript drift detection packages." });
  assert.ok(r.reasons.some(x => x.kind === "persona"));
});
test("user decisions are recorded", async () => {
  const m = new AlignmentMonitor({ ...anchor, decisions: [] });
  await m.addTurn({ role: "user", content: "We decided to use node:test." });
  assert.deepEqual(m.anchor.decisions, ["use node:test"]);
});
test("pluggable judge raises score", async () => {
  const r = await check(anchor, [{ role: "assistant", content: "Building the TypeScript drift detection package." }], { judge: { evaluate: async () => ({ score: 0.9, reasons: ["judge says off"] }) } });
  assert.deepEqual(r.driftPoints, [0]);
});
test("markdown transcript parsing", () => {
  const p = parseTranscript("User: hi\nthere\nAssistant: hello");
  assert.equal(p.turns.length, 2); assert.equal(p.turns[0].content, "hi\nthere");
});
test("state round-trip", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ra-")), "s.json");
  const s = loadState(f); s.anchors.default = anchor; saveState(f, s);
  assert.deepEqual(loadState(f).anchors.default, anchor);
});
test("similarity helpers", () => { assert.equal(jaccard(tokenize("drift package"), tokenize("package drift")), 1); });
