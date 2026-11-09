# @spica/core

The Spica agent core, written from scratch with no agent framework and no runtime
dependencies (Node 24 built-ins only). It runs in plain Node, so the desktop app's
main process, the MCP server and tests can all drive it.

## What is in it

- **Agent loop** (`Session`): segment-based context assembly, streaming model
  calls, parallel tool execution, stop conditions (no tool calls, max turns,
  spending limits, abort).
- **Providers**: `OpenAICompatibleProvider` (chat completions over SSE; works with
  LiteLLM and other compatible gateways) and `AnthropicProvider` (Messages API,
  native streaming, prompt caching, optional hosted web search). Both share one HTTP
  layer with retry/backoff, timeouts, cancellation and a one-time credential refresh
  after a 401.
- **Events**: every step is published on `runtime.events` as a typed `CoreEvent`
  (types live in `@spica/protocol`).
- **Traceable records**: one `TraceRecord` per external request (time, initiator,
  parent chain, duration, tokens, estimated cost, status); export as JSON Lines.
  Records never contain headers, bodies or keys.
- **Spending limits**: global / per session / per run / per call, plus per provider.
- **Rate limiting**: one limiter per provider, shared by all sessions.
- **Built-in tools**: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
  `grep`. Every tool result starts with the time the data was fetched.
- **Hooks** for plugins: injections at six context positions, before-request,
  after-response, before-tool and after-tool; everything a plugin registers can be
  withdrawn at once.

## Quick start

```ts
import { Runtime, OpenAICompatibleProvider } from '@spica/core';

const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'llm', baseUrl: process.env.BASE_URL!, apiKey: process.env.API_KEY })],
  defaults: { providerId: 'llm', model: 'my-model', maxTokens: 2048 },
  cwd: '/path/to/project',
});
rt.events.on((e) => console.log(e.type));
const session = rt.createSession({ title: 'Hello' });
const result = await session.send('Summarize README.md').done;
console.log(result.text);
```

## Scripts

- `npm test` (from the repository root) runs the unit and integration tests against
  a built-in fake gateway (`src/testing/fake-gateway.ts`).
- `npm run smoke:deepseek` / `npm run smoke:claude` run a short real-model
  conversation (read a file, grep, answer) using keys from `.env.local` at the
  repository root, and print the event summary and traceable records.

The design document (Chinese) is `docs/design/agent-core.md`.
