# Spica

Spica is an open-source desktop agent workbench for Windows: a personal team of AI agents
(a top-level agent, one project-manager agent per project, and sub-agents you can step into)
that helps you push multi-stage work forward.

> Status: early skeleton. The window opens and shows the mark; the agent core is not written yet.

## Quick start

Requirements: Windows 10/11 and Node.js 24 (no administrator rights needed).

```sh
npm install
npm run dev
```

A window opens showing the Spica mark, the name and the version.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the desktop app in development mode |
| `npm run build` | Build the desktop app bundles |
| `npm run lint` | ESLint over the whole repository |
| `npm run typecheck` | TypeScript type check for every workspace |
| `npm test` | Run unit tests (Vitest) |
| `npm run scan:sensitive` | Scan tracked files for sensitive words |

## Repository layout

```
apps/desktop        Electron shell (main, preload, renderer)
packages/core       Agent core (not written yet)
packages/protocol   Backend API and event type definitions (not written yet)
plugins/            Official plugins
scripts/            Repository scripts (sensitive-word scan, ...)
docs/design/        Design documents (in Chinese)
```

Conventions (no console windows, per-user install, how to add a package, ...) are in
[docs/design/repo-layout.md](docs/design/repo-layout.md).

## Configuration

Copy `.env.example` to `.env.local` and fill in your model endpoints and keys.
`.env.local` is ignored by git; keys never enter the repository.

## Sensitive-word scan

CI fails if a tracked file contains a word from the word list. The repository ships only
generic example words in `scripts/sensitive-words/words.example.txt`. A private fork injects
its own list with the `SPICA_SENSITIVE_WORDS` environment variable (a file path) or
`--words <path>`.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
