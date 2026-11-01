import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlignmentMonitor,
  TfIdf,
  check,
  compileConstraint,
  cosine,
  formatMarkdown,
  jaccard,
  loadState,
  parseTranscript,
  resolveConfig,
  saveState,
  severityOf,
  stem,
  toAnchor,
  tokenize,
  emptyAnchor,
  type Anchor,
  type Judge,
} from "../src/index.js";

const anchor: Anchor = {
  goals: ["build a TypeScript drift detection package"],
  constraints: [
    "never use python or emojis",
    { rule: "keep it private", forbid: ["make it public"], pattern: "\\bpublic repo\\b" },
  ],
  persona: "Taloose, friendly",
  decisions: ["use node:test for tests"],
};
const onTopic = {
  role: "assistant" as const,
  content: "Building the TypeScript drift detection package now.",
};

describe("text", () => {
  test("tokenize removes stopwords and stems", () => {
    assert.deepEqual(tokenize("The packages are building quickly!"), ["package", "build", "quickly"]);
    assert.equal(stem("passes"), "passe");
    assert.equal(stem("class"), "class");
    assert.equal(stem("started"), "start");
  });
  test("tf-idf cosine is 1 for identical docs and 0 for disjoint", () => {
    const idf = new TfIdf([["a1", "b1"], ["c1"]]);
    assert.ok(Math.abs(cosine(idf.vector(["a1", "b1"]), idf.vector(["a1", "b1"])) - 1) < 1e-9);
    assert.equal(cosine(idf.vector(["a1"]), idf.vector(["c1"])), 0);
    assert.equal(cosine(new Map(), idf.vector(["c1"])), 0);
    assert.ok(idf.idf("zzz") > idf.idf("a1"));
  });
  test("jaccard", () => {
    assert.equal(jaccard(["a", "b"], ["b", "a"]), 1);
    assert.equal(jaccard([], ["a"]), 0);
  });
});

describe("config", () => {
  test("resolveConfig merges nested weights", () => {
    const c = resolveConfig({ weights: { topic: 0.9 }, severity: { high: 0.95 } });
    assert.equal(c.weights.topic, 0.9);
    assert.equal(c.weights.goal, 0.3);
    assert.equal(c.severity.high, 0.95);
    assert.equal(c.severity.low, 0.2);
  });
  test("severityOf", () => {
    const s = resolveConfig().severity;
    assert.deepEqual(
      [0, 0.3, 0.6, 0.9].map((x) => severityOf(x, s)),
      ["none", "low", "medium", "high"],
    );
  });
  test("compileConstraint", () => {
    assert.deepEqual(compileConstraint("never use python").forbid, ["python"]);
    assert.deepEqual(compileConstraint("be polite").forbid, []);
    const c = compileConstraint({ rule: "x", forbid: ["Foo Bar"], pattern: "abc" });
    assert.deepEqual(c.forbid, ["foo bar"]);
    assert.ok(c.pattern?.test("ABC"));
    assert.deepEqual(compileConstraint({ rule: "y" }).forbid, []);
  });
});

describe("AlignmentMonitor", () => {
  test("on-topic reply scores zero; user/system turns are never scored", async () => {
    const m = new AlignmentMonitor(anchor);
    assert.equal((await m.addTurn({ role: "system", content: "python python" })).score, 0);
    assert.equal((await m.addTurn({ role: "user", content: "build it" })).score, 0);
    const r = await m.addTurn(onTopic);
    assert.equal(r.score, 0);
    assert.equal(r.severity, "none");
    assert.equal(m.report().realignment, null);
  });

  test("each heuristic fires", () => {
    const m = new AlignmentMonitor(anchor);
    const kinds = (content: string) => m.scoreTurn({ role: "assistant", content }).reasons.map((r) => r.kind);
    assert.ok(kinds("Here is a python script for the drift detection package").includes("constraint"));
    assert.ok(kinds("Let's make it public for the drift detection package").includes("constraint"));
    assert.ok(kinds("Pushing to a public repo with the TypeScript drift package").includes("constraint"));
    assert.ok(
      kinds("Actually, switch to jest instead of node:test for tests in the package").includes("decision"),
    );
    assert.ok(kinds("We should not use node:test for tests in the TypeScript package").includes("decision"));
    assert.ok(kinds("Hi, I'm Grokbert, building the TypeScript drift detection package").includes("persona"));
    assert.ok(!kinds("Hi, I'm Taloose, building the TypeScript drift detection package").includes("persona"));
    assert.ok(kinds("Bananas are yellow fruit").includes("goal"));
  });

  test("topic shift uses the rolling window", async () => {
    const m = new AlignmentMonitor(anchor, { windowSize: 2 });
    await m.addTurn({ role: "user", content: "Let's design the drift detection scoring engine" });
    const r = await m.addTurn({
      role: "assistant",
      content: "Bananas mangoes pineapples coconuts papayas guavas lychees",
    });
    assert.ok(r.reasons.some((x) => x.kind === "topic"));
    assert.ok(r.drifted);
    assert.equal(m.lastDrift()?.index, 1);
  });

  test("configurable weights and threshold", () => {
    const m = new AlignmentMonitor(anchor, { weights: { constraint: 0.1 }, threshold: 0.9 });
    const r = m.scoreTurn({ role: "assistant", content: "python drift detection TypeScript package" });
    assert.equal(r.score, 0.1);
    assert.equal(r.drifted, false);
    assert.equal(r.severity, "none");
  });

  test("events: turn, drift, decision; unsubscribe works", async () => {
    const m = new AlignmentMonitor({ ...anchor, decisions: [] });
    const seen: string[] = [];
    const off = m.on("turn", () => seen.push("turn"));
    m.on("drift", (e) => seen.push(e.realignment.startsWith("[REALIGN]") ? "drift" : "?"));
    m.on("decision", (e) => seen.push(`decision:${e.decision}`));
    await m.addTurn({ role: "user", content: "We decided to use vitest. " });
    await m.addTurn({ role: "user", content: "Decision: use vitest" });
    off();
    await m.addTurn({ role: "assistant", content: "python python python, drifting with emojis and bananas" });
    assert.deepEqual(seen, ["decision:use vitest", "turn", "turn", "drift"]);
    assert.deepEqual(m.anchor.decisions, ["use vitest"]);
  });

  test("autoRecordDecisions can be disabled and anchor is not mutated", async () => {
    const a: Anchor = { goals: [], constraints: [], decisions: [] };
    const m = new AlignmentMonitor(a, { autoRecordDecisions: false });
    await m.addTurn({ role: "user", content: "we decided to ship" });
    assert.deepEqual(m.anchor.decisions, []);
    const m2 = new AlignmentMonitor(a);
    await m2.addTurn({ role: "user", content: "we decided to ship" });
    assert.deepEqual(a.decisions, []);
    assert.deepEqual(m2.anchor.decisions, ["ship"]);
  });

  test("realignment is compact, targeted and capped", async () => {
    const m = new AlignmentMonitor(anchor, { maxRealignChars: 120 });
    await m.addTurn({ role: "assistant", content: "I'm Grokbert. Python python python bananas" });
    const msg = m.realignment();
    assert.ok(msg.length <= 120);
    assert.ok(msg.endsWith("…"));
    const full = new AlignmentMonitor(anchor).realignment();
    assert.match(full, /You are Taloose/);
    assert.match(full, /Rules:/);
    assert.match(full, /Settled:/);
    assert.doesNotMatch(full, /drifted/);
  });

  test("judge raises the score, and judge errors fail open", async () => {
    const judge: Judge = { name: "j", evaluate: async () => ({ score: 0.8, reasons: [] }) };
    const r = await check(anchor, [onTopic], { judge });
    assert.deepEqual(r.driftPoints, [0]);
    assert.equal(r.byKind.judge, 1);
    assert.match(r.realignment!, /Rules:/);
    const bad: Judge = { name: "bad", evaluate: async () => Promise.reject(new Error("down")) };
    const r2 = await check(anchor, [onTopic], { judge: bad });
    assert.equal(r2.maxScore, 0);
    assert.match(r2.turns[0]!.reasons[0]!.detail, /unavailable: down/);
    const zero: Judge = { name: "z", evaluate: async () => ({ score: 0, reasons: [] }) };
    assert.equal((await check(anchor, [onTopic], { judge: zero })).maxScore, 0);
  });

  test("session report aggregates", async () => {
    const r = await check(anchor, [
      { role: "user", content: "go" },
      onTopic,
      { role: "assistant", content: "python emojis everywhere, totally unrelated cooking recipes" },
    ]);
    assert.equal(r.assistantTurns, 2);
    assert.deepEqual(r.driftPoints, [2]);
    assert.ok(r.meanScore > 0 && r.meanScore < 1);
    assert.ok(r.byKind.constraint >= 1);
    const empty = await check(anchor, []);
    assert.equal(empty.meanScore, 0);
    assert.equal(empty.maxScore, 0);
  });

  test("reset clears history", async () => {
    const m = new AlignmentMonitor(anchor);
    await m.addTurns([onTopic, onTopic]);
    m.reset();
    assert.equal(m.turns.length, 0);
    assert.equal(m.report().assistantTurns, 0);
  });
});

describe("state", () => {
  const dir = mkdtempSync(join(tmpdir(), "ra-core-"));
  test("round-trip, missing file, nested dir", () => {
    const f = join(dir, "nested", "s.json");
    assert.deepEqual(loadState(f), { version: 1, anchors: {} });
    saveState(f, { version: 1, anchors: { a: anchor } });
    assert.deepEqual(loadState(f).anchors.a, anchor);
    assert.ok(!existsSync(`${f}.${process.pid}.tmp`));
  });
  test("validation errors", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ version: 2 }));
    assert.throws(() => loadState(f), /unsupported state version/);
    assert.throws(() => toAnchor(null), /must be an object/);
    assert.throws(() => toAnchor({ goals: "x" }), /goals must be an array/);
    assert.throws(() => toAnchor({ persona: 3 }), /persona must be a string/);
    assert.deepEqual(toAnchor({}), emptyAnchor());
    writeFileSync(f, JSON.stringify({ version: 1 }));
    assert.deepEqual(loadState(f).anchors, {});
  });
});

describe("transcripts", () => {
  test("JSON object with anchor, messages, bare array", () => {
    const a = parseTranscript(JSON.stringify({ anchor, turns: [{ role: "Human", content: "hi" }] }));
    assert.equal(a.anchor?.persona, "Taloose, friendly");
    assert.deepEqual(a.turns, [{ role: "user", content: "hi" }]);
    assert.equal(
      parseTranscript(JSON.stringify({ messages: [{ role: "ai", content: "yo" }] })).turns[0]!.role,
      "assistant",
    );
    assert.equal(
      parseTranscript(JSON.stringify([{ role: "system", content: { x: 1 } }])).turns[0]!.content,
      '{"x":1}',
    );
    assert.equal(parseTranscript(JSON.stringify([{ role: "bot" }])).turns[0]!.content, '""');
    assert.deepEqual(parseTranscript(JSON.stringify({})).turns, []);
  });
  test("JSONL", () => {
    const t = parseTranscript('{"role":"user","content":"a"}\n{"role":"assistant","content":"b"}\n');
    assert.equal(t.turns.length, 2);
  });
  test("errors", () => {
    assert.throws(() => parseTranscript('[{"role":"alien","content":"x"}]'), /unknown role/);
    assert.throws(() => parseTranscript("{not json"), SyntaxError);
  });
  test("markdown variants and continuation lines", () => {
    const t = parseTranscript(
      "intro ignored\n## User\nhello\nworld\n**Assistant:** hi there\n> user: quoted\nAI: ok",
    );
    assert.deepEqual(
      t.turns.map((x) => [x.role, x.content]),
      [
        ["user", "hello\nworld"],
        ["assistant", "hi there"],
        ["user", "quoted"],
        ["assistant", "ok"],
      ],
    );
    assert.deepEqual(parseTranscript("   ").turns, []);
    assert.equal(parseTranscript("User said nothing special").turns.length, 0);
  });
});

test("formatMarkdown renders table, kinds and realignment", async () => {
  const r = await check(anchor, [
    onTopic,
    { role: "assistant", content: "python | bananas and emojis cooking" },
  ]);
  const md = formatMarkdown(r, "T");
  assert.match(md, /^# T/);
  assert.match(md, /\| 1 \|/);
  assert.match(md, /## Drift by kind/);
  assert.match(md, /## Suggested realignment/);
  const clean = formatMarkdown(await check(anchor, [onTopic]));
  assert.doesNotMatch(clean, /Suggested/);
});
