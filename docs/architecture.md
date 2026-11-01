# Architecture

```
packages/
  core/        @recurring-alignment/core        engine, TF-IDF, events, state, transcript parsing, reports
  judges/      @recurring-alignment/judges      optional LLM judges (OpenAI-/Anthropic-compatible, mock)
  middleware/  @recurring-alignment/middleware  withAlignment(chatFn): check replies, auto-inject realign notes
  replay/      @recurring-alignment/replay      Drift Replay: find drift start, build a clean resume state
  cli/         recurring-alignment              check · watch · report · replay · anchor
```

Dependencies only point toward `core`. `core` has **zero runtime dependencies** and needs no network or API keys.

## Data flow

```
Anchor ──┐
         ▼
Turn ─► AlignmentMonitor.addTurn() ─► heuristics (+ optional Judge) ─► TurnReport
                │                                                        │
                ├─ emits "turn", "drift", "decision" events              │
                └─ realignment(report) ─► "[REALIGN] …" note ◄────────────┘
```

- **Anchor**: goals, constraints, persona, decisions. It persists in a JSON state file (`{ version: 1, anchors: { name: Anchor } }`) that is written atomically.
- **Rolling window**: topic similarity uses the last `windowSize` on-track turns.
- **Typed events**: `monitor.on("drift", ({ report, realignment }) => …)` returns an unsubscribe function.
- **Fail-open judges**: if a judge errors or times out, the turn is still scored with heuristics, and the error is recorded as a zero-weight reason.
- **Realignment** is targeted. It only restates the parts of the anchor related to the detected drift, and it is capped at `maxRealignChars` (default 600).

## Design choices

- **Heuristics first.** They are free, deterministic, private, and fast (well under 1 ms per turn). An LLM judge is an optional second opinion.
- **No dependencies in `core`.** It is easy to audit and embed anywhere, including browsers (only `state.ts` uses `node:fs`).
- **Exit codes** for automation: `0` ok, `1` error, `2` drift found.
