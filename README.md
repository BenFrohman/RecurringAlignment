# RecurringAlignment

Detect **drift** in ongoing conversations with AI assistants and generate a compact **realignment prompt** to inject into the same context. That keeps the goal, rules, persona, and earlier decisions consistent across turns without restarting the session or spending tokens on a full re-prompt.

## How it works
You define an **anchor**: goals, constraints, persona, and decisions. Each assistant turn is scored from 0 to 1 using local heuristics. No API keys are needed.
- **goal**: low token coverage of the stated goals
- **constraint**: mentions something a "no/never/avoid X" rule forbids
- **decision**: reversal language ("actually", "instead", "switch to") combined with overlap with a recorded decision
- **persona**: the assistant introduces itself by a different name
- **topic**: low Jaccard similarity to the recent context window plus the goals

User lines such as `We decided to …` or `Decision: …` are added to the anchor automatically. You can also plug in an optional `Judge` (for example an LLM) to add its own score.

## CLI
```bash
npm install && npm run build
node dist/src/cli.js check examples/transcript.json          # exits 2 if drift is found
node dist/src/cli.js check chat.md --state .ra.json --anchor default --json
node dist/src/cli.js anchor set default --state .ra.json --goal "ship v1" --constraint "never use python" --decision "repo stays private" --persona "Taloose, friendly"
```
A transcript can be JSON (`{anchor, turns}` or `Turn[]`) or Markdown with `User:` / `Assistant:` lines.

## Library
```ts
import { AlignmentMonitor } from "recurring-alignment";
const m = new AlignmentMonitor({ goals: ["build drift package"], constraints: ["never use python"], persona: "Taloose", decisions: [] }, { threshold: 0.5 });
const r = await m.addTurn({ role: "assistant", content: "Let's rewrite it in python" });
if (r.drifted) inject(m.realignment());   // "[REALIGN]\nGoal: ...\nRules: ...\nDrift at turn 0: ..."
```
For persistence across sessions, use `loadState(path)` and `saveState(path, state)`.

## License
MIT
