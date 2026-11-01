# RecurringAlignment

**Keep your AI conversations on track.**

Long chats with AI assistants drift. The assistant forgets the goal, breaks a rule you set, undoes a decision you already made, or wanders off topic. Starting over wastes tokens and context. RecurringAlignment watches the conversation, flags the exact turn where it drifted and explains why, and writes a short **realignment note** you can drop into the _same_ chat to get it back on course.

- 🧭 **Anchor**: write down what matters once (goals, rules, persona, decisions). It is saved to a JSON file, so it carries over between sessions.
- 📈 **Drift score per turn** (0 to 1) with plain-English reasons and a severity level.
- 🪄 **Realign note**: a compact message (under 600 characters by default) to paste or auto-inject.
- ⏪ **Drift Replay**: find where drift _began_ and rebuild a clean, smaller context to resume a fresh session.
- 🔌 Works offline with **no API keys**. An LLM judge is optional.

## Quickstart (2 minutes)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd RecurringAlignment
npm install && npm run demo
```

That builds everything, checks the example conversation in `examples/transcript.json`, and runs the middleware demo. You'll see output like:

```
ok    turn   1  score 0.00 (none)
ok    turn   3  score 0.00 (none)
DRIFT turn   4  score 1.00 (high)  — breaks rule "never use python" (python); may undo decision "use node:test for tests"; …
DRIFT turn   5  score 1.00 (high)  — calls itself "Grokbert" instead of "Taloose"; …

Paste this into the conversation:

[REALIGN]
You are Taloose, friendly and concise.
Goal: build a TypeScript drift detection package called RecurringAlignment.
Turn 5 drifted (high): …
Continue from here, back on track, without mentioning this note.
```

## Use it on your own chat

1. **Save your chat** to a file. Plain text works:

   ```
   User: Help me plan a budget Chicago trip. Decision: we stay in the West Loop.
   Assistant: Great! Day 1: …
   ```

   JSON (`[{ "role": "user", "content": "…" }]`), `{ "messages": [...] }`, and JSONL also work.

2. **Write your anchor**, which is what the chat is supposed to be about:

   ```bash
   npx recurring-alignment anchor set --goal "plan a 3-day budget Chicago trip" --constraint "avoid luxury" --persona "Taloose"
   npx recurring-alignment anchor show
   ```

   This creates `.recurring-alignment.json` in the current folder. Use `--anchor <name>` to keep several anchors.

3. **Check it:**

   ```bash
   npx recurring-alignment check chat.md            # human-readable
   npx recurring-alignment check chat.md --json     # for scripts
   ```

   Exit codes: `0` on track, `2` drift found, `1` error.

## All commands

| Command                                    | What it does                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `check <file>`                             | Score every assistant turn and print a realign note if needed                                           |
| `watch <file>`                             | Keep watching a file as the chat grows and print realign notes **live** (`--once` to run a single pass) |
| `report <file>`                            | Session summary in Markdown (default) or `--format json`, optionally `--out report.md`                  |
| `replay <file> --out clean.json\|clean.md` | **Drift Replay**: see below                                                                             |
| `anchor init\|set\|show [name]`            | Manage saved anchors                                                                                    |

Useful flags: `--threshold 0.4`, `--window 8`, `--weight topic=0.5`, `--judge mock|openai|anthropic`, `--state path.json`, `--anchor name`.

## ⏪ Drift Replay

When a chat has gone badly off course, it's often better to **restart fresh from where it was still good** than to keep patching it. Replay does that for you:

```bash
npx recurring-alignment replay examples/long-session.md --state examples/state.json --anchor trip --out clean.md
# drift began at turn 7; dropped 4 turn(s); tokens ~412 -> ~359. Wrote clean.md
```

It:

1. **Finds where drift began.** That's the first drifted turn, pulled back over any warning-level slide into it.
2. **Drops** the drifted turns and noise ("ok", "thanks").
3. **Builds a clean state:**
   - goals and rules
   - **still-valid decisions** (including ones you stated mid-chat, minus ones you later reversed)
   - the most goal-relevant **key facts**
   - **open tasks**: requests that never got an on-track answer
   - the last few good turns
4. **Estimates tokens** before and after.

Use `--out clean.json` to get a file with a ready-to-send `messages` array (one system prompt plus recent turns). That file is itself a valid transcript with its anchor embedded, so `recurring-alignment check clean.json` works on it. Savings grow with longer sessions, because the clean state stays about the same size while the transcript keeps growing.

```ts
import { replay, toMessages } from "@recurring-alignment/replay";
const r = await replay(anchor, turns);
console.log(r.driftStart, r.tokens); // 7 { before: 412, after: 359, saved: 53, ratio: 0.871 }
const freshSession = toMessages(r.clean); // send these to your model
```

## Library

```ts
import { AlignmentMonitor } from "@recurring-alignment/core";

const monitor = new AlignmentMonitor(
  {
    goals: ["build a TypeScript drift detection package"],
    constraints: ["never use python", { rule: "keep it private", forbid: ["make it public"] }],
    persona: "Taloose, friendly",
    decisions: ["use node:test for tests"],
  },
  { threshold: 0.5, windowSize: 6, weights: { topic: 0.4 } },
);

monitor.on("drift", ({ report, realignment }) => console.log(report.severity, realignment));
const report = await monitor.addTurn({ role: "assistant", content: "Let's rewrite it in python!" });
// report: { score: 0.9, severity: "high", drifted: true, reasons: [{ kind: "constraint", detail: "breaks rule …" }, …] }
```

**Auto-pilot for any chat API:** wrap your completion function, and drifted replies automatically trigger a realign note in the next request:

```ts
import { withAlignment } from "@recurring-alignment/middleware";
const chat = withAlignment((messages) => openai.chat.completions.create({ model, messages }), { anchor });
```

See [`examples/middleware-demo.mjs`](examples/middleware-demo.mjs) and [docs/integrations.md](docs/integrations.md) for judges.

## How it decides (short version)

Each assistant reply is checked for:

- **goal**: does it still talk about the goal?
- **constraint**: does it break a rule?
- **decision**: does it undo something you settled?
- **persona**: does it call itself by another name?
- **topic**: is it still related to recent on-track turns? This uses TF-IDF and cosine similarity.

Each check gives a number from 0 to 1. The numbers are multiplied by weights and summed into the score. **Full formulas and a worked example are in [docs/scoring.md](docs/scoring.md).**

## Packages

| Package                                                  |                                                          |
| -------------------------------------------------------- | -------------------------------------------------------- |
| [`@recurring-alignment/core`](packages/core)             | Engine, zero dependencies                                |
| [`@recurring-alignment/judges`](packages/judges)         | Optional LLM judges (OpenAI-/Anthropic-compatible, mock) |
| [`@recurring-alignment/middleware`](packages/middleware) | `withAlignment()` wrapper                                |
| [`@recurring-alignment/replay`](packages/replay)         | Drift Replay                                             |
| [`recurring-alignment`](packages/cli)                    | CLI                                                      |

More: [architecture](docs/architecture.md) · [contributing](CONTRIBUTING.md) · [changelog](CHANGELOG.md)

## Privacy

Everything runs locally by default. Nothing leaves your machine unless you turn on an LLM judge, and API keys are read only from environment variables.

## License

MIT © Benjamin Frohman
