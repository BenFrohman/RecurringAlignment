# Changelog

## 0.2.0 (2026-10-30)

### Added

- Monorepo with npm workspaces: `core`, `judges`, `middleware`, `replay`, `cli`.
- **Drift Replay** (`@recurring-alignment/replay`, `recurring-alignment replay`): finds where drift began, drops drifted and noisy turns, and builds a clean resume state (goals, still-valid decisions, key facts, open tasks, recent turns) with before/after token estimates.
- TF-IDF + cosine similarity, configurable weights, severity levels, a rolling window of on-track turns, and typed events (`turn`, `drift`, `decision`).
- Structured constraints (`{ rule, forbid, pattern }`), persona checks, and auto-recording of user decisions.
- CLI commands `watch` (live tail), `report` (Markdown/JSON), and `anchor init|set|show`, plus `--json`, `--weight`, `--window`, and `--judge`.
- Optional OpenAI-compatible and Anthropic-compatible judges, plus a mock judge.
- `withAlignment` middleware that auto-injects realignment notes.
- Docs (including the scoring math), examples, CI workflow, ESLint and Prettier.

## 0.1.0 (2026-10-30)

- Initial single-package prototype.
