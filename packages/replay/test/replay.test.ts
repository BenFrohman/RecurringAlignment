import { test } from "node:test";
import assert from "node:assert/strict";
import type { Anchor, Turn } from "@recurring-alignment/core";
import {
  estimateTokens,
  replay,
  toMarkdown,
  toMessages,
  toResumeJSON,
  toSystemPrompt,
} from "../src/index.js";

const anchor: Anchor = {
  goals: ["plan a 3-day budget Chicago trip for two"],
  constraints: ["avoid luxury"],
  persona: "Taloose",
  decisions: [],
};
const T = (role: Turn["role"], content: string): Turn => ({ role, content });
const session: Turn[] = [
  T("user", "Plan a 3-day budget Chicago trip for two in May. Decision: we stay in the West Loop."),
  T(
    "assistant",
    "Budget Chicago trip: West Loop lodging is about $200 a night, and a 3-day Ventra pass is $15 each for the trip.",
  ),
  T("user", "ok"),
  T(
    "assistant",
    "Day 1 of the Chicago trip: Riverwalk and a cheap budget lunch at Time Out Market in the West Loop.",
  ),
  T("user", "We decided to skip observation decks. What about day 2?"),
  T(
    "assistant",
    "Day 2 of the budget Chicago trip: Art Institute and Millennium Park, both free or cheap for two.",
  ),
  T("user", "thanks"),
  T(
    "assistant",
    "Forget that, book a luxury Caribbean cruise with five-star suites, butlers and champagne instead!",
  ),
  T(
    "assistant",
    "Cruise balcony cabins, casino nights, spa packages and Cozumel shore excursions are amazing.",
  ),
  T("user", "Can you suggest a cheap breakfast near the West Loop?"),
];

test("finds where drift began, drops drift + noise, keeps decisions and open tasks", async () => {
  const r = await replay(anchor, session);
  assert.equal(r.driftStart, 7);
  assert.deepEqual(r.driftPoints, [7]);
  assert.deepEqual(r.dropped, [
    { index: 2, why: "noise" },
    { index: 6, why: "noise" },
    { index: 7, why: "drift" },
    { index: 8, why: "drift" },
  ]);
  assert.deepEqual(r.clean.decisions, ["we stay in the West Loop", "skip observation decks"]);
  assert.deepEqual(r.clean.openTasks, ["Can you suggest a cheap breakfast near the West Loop?"]);
  assert.ok(r.clean.keyFacts.length > 0);
  assert.ok(r.clean.keyFacts.every((f) => !/cruise/i.test(f)));
  assert.ok(r.clean.recentTurns.every((t) => !/cruise/i.test(t.content)));
  assert.equal(r.clean.recentTurns.length, 4);
  const lean = await replay(anchor, session, { recentTurns: 1 });
  assert.ok(lean.tokens.after < lean.tokens.before, `${lean.tokens.after} < ${lean.tokens.before}`);
  assert.equal(r.tokens.saved, r.tokens.before - r.tokens.after);
});

test("drift start extends back over warning-level slide", async () => {
  const r = await replay(anchor, session, { config: { severity: { low: 0.0001 } } });
  assert.ok(r.driftStart !== null && r.driftStart <= 7);
});

test("clean transcript: no drift, nothing dropped but noise", async () => {
  const r = await replay(anchor, session.slice(0, 6));
  assert.equal(r.driftStart, null);
  assert.deepEqual(r.dropped, [{ index: 2, why: "noise" }]);
  assert.deepEqual(r.clean.openTasks, []);
});

test("user-reversed decisions are removed; options respected", async () => {
  const turns = [
    T("user", "Decision: we stay in the West Loop"),
    T("user", "Actually scrap staying in the West Loop, pick River North"),
    T("assistant", "Sure, River North for the budget Chicago trip it is. ".repeat(20)),
  ];
  const r = await replay(anchor, turns, {
    recentTurns: 1,
    excerptChars: 50,
    maxFacts: 1,
    estimateTokens: (s) => s.length,
  });
  assert.deepEqual(r.clean.decisions, []);
  assert.equal(r.clean.recentTurns.length, 1);
  assert.equal(r.clean.recentTurns[0]!.content.length, 50);
  assert.ok(r.clean.keyFacts.length <= 1);
});

test("no goals: facts still extracted; empty transcript", async () => {
  const r = await replay(
    { goals: [], constraints: [], decisions: [] },
    [T("user", "remember the code word is pineapple express")],
    {
      recentTurns: 0,
    },
  );
  assert.deepEqual(r.clean.keyFacts, ["remember the code word is pineapple express"]);
  const e = await replay(anchor, []);
  assert.equal(e.tokens.ratio, 0);
  assert.equal(e.driftStart, null);
});

test("renderers", async () => {
  const r = await replay(anchor, session);
  const sys = toSystemPrompt(r.clean);
  for (const s of [
    "[RESUME",
    "You are Taloose",
    "Goals:",
    "Rules: avoid luxury",
    "Settled decisions:",
    "Key facts:",
    "Open tasks:",
  ])
    assert.ok(sys.includes(s), s);
  const msgs = toMessages(r.clean);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs.length, 5);
  const md = toMarkdown(r);
  assert.match(md, /Drift began at: \*\*turn 7\*\*/);
  assert.match(md, /## Resume prompt/);
  const j = toResumeJSON(r);
  assert.equal(j.anchor.persona, "Taloose");
  assert.equal(j.meta.driftStart, 7);
  const bare = await replay({ goals: [], constraints: [], decisions: [] }, []);
  assert.match(toMarkdown(bare), /never \(no drift found\)/);
  assert.match(toMarkdown(bare), /Dropped turns: none/);
  assert.equal(toResumeJSON(bare).anchor.persona, undefined);
  assert.equal(
    toSystemPrompt(bare.clean),
    "[RESUME: clean state from RecurringAlignment Drift Replay]\nContinue from the recent turns below.",
  );
  assert.equal(estimateTokens("abcde"), 2);
});
