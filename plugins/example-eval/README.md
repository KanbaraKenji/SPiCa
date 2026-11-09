# Evaluation (example plugin)

A template for evaluation plugins. It drives Spica **only through Spica's own MCP
service** (the `spica_*` tools), runs the acceptance journeys and writes a Markdown
report: pass / fail / skipped, time and cost per journey.

| Journey | What it checks |
|---|---|
| J2 | Reads a PDF, a Word file and an Excel file and answers from them, with file cards |
| J3 | Creates a project; the project manager starts two sub-agents |
| J4 | The user redirects one sub-agent; the project manager follows the change |
| J5 | Question card → confirmation → the command runs |
| J6 | Installs the example notes plugin, the agent uses it; after disabling it the agent cannot (same steps as `packages/plugins/scripts/journey-j6.ts`) |
| J7 | Spica is closed in the middle of a run, started again, and the run resumes |

## Run it

Fresh Spica on a temporary database, DeepSeek from `.env.local` (costs a few cents):

```
npm run eval -w @spica/plugin-example-eval -- --out report.md --log usage.jsonl
npm run eval -w @spica/plugin-example-eval -- --only J2,J5
```

Against a Spica that is already running with MCP over HTTP (see
`docs/design/agent-core.md` §12b; J2–J4 and J7 are skipped because they need sample
files next to Spica or a restart):

```
SPICA_MCP_TOKEN=… node src/run.ts --url http://127.0.0.1:<port>/mcp
```

`--log` also exports the usage log of the evaluated Spica (`spica_export_usage_log`,
JSON Lines, keys and endpoint addresses removed). The report never contains the
model key, the endpoint address or the MCP token.

## Files

| File | What it is |
|---|---|
| `manifest.json` | Plugin manifest; the plugin adds no tools to the agents |
| `src/link.ts` | The only way it talks to Spica: MCP over stdio (starts Spica) or HTTP (a running Spica) |
| `src/journeys.ts` | The journeys, each a list of `spica_*` calls and checks |
| `src/evaluate.ts` | Runs journeys in order; time per journey, cost and request count from Spica's traceable records |
| `src/report.ts` | The Markdown report |
| `src/run.ts` | Command line: sample files, backend config, start, run, report |

## Write your own

Add a `Journey` to `src/journeys.ts` (or your own list): an id, the checks it reports,
and `run(ctx)` that calls `ctx.link.call('spica_…', args)` and returns `{ id, title, ok,
note }` per check. Mark `needsLocalFixtures` / `needsRestart` when it needs files this
run puts next to Spica or a restart. Keep checks about what a user would see (the
answer, the cards, which tools ran), not about internal ids.
