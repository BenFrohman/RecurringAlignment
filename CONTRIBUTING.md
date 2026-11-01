# Contributing

```bash
npm install
npm test          # build + all tests
npm run coverage  # enforces ≥90% lines/functions, ≥80% branches
npm run lint      # eslint + prettier --check
npm run format    # auto-format
```

- Node 20+. The code is TypeScript (strict, `noUncheckedIndexedAccess`) with project references (`tsc -b`).
- Tests use the built-in `node:test` runner and live in `packages/*/test`.
- New heuristics go in `packages/core/src/engine.ts`. Add a weight in `types.ts`, a test in `core.test.ts`, and a row in `docs/scoring.md`.
- Keep `core` free of runtime dependencies.
- Never commit API keys. Judges read keys from the environment only.
- Keep commits small, and update `CHANGELOG.md` under "Unreleased".

## Publishing (maintainer)

Publish the packages in dependency order. Each package builds itself on `npm pack`/`npm publish` via `prepack`. Scoped packages are published as public.

```sh
npm ci && npm test
npm publish -w @recurring-alignment/core
npm publish -w @recurring-alignment/judges
npm publish -w @recurring-alignment/middleware
npm publish -w @recurring-alignment/replay
npm publish -w recurring-alignment
```
