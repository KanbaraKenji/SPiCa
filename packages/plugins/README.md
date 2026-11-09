# @spica/plugins

Spica's plugin system.

- **Plugin folder format**: `manifest.json` (MCPB-style) plus `skills/`, `commands/`, `mcp/`
  (standard parts) and `hooks/`, `services/`, `views/` (extensions).
- **Lifecycle**: `PluginManager` installs, enables, disables, uninstalls and rolls back
  plugins. Enabling registers skills → MCP tools → hooks → services under the source
  `plugin:<name>`; disabling withdraws all of it, so nothing is left behind.
- **External processes** are MCP servers started through the agent core's MCP client:
  Node servers run on the host's own Node (Electron with `ELECTRON_RUN_AS_NODE=1`), other
  servers ship as a bundled executable. Crashes are restarted up to a limit.
- **Mock mode**: one global switch, passed to servers as `SPICA_MOCK=1`.
- **Packaging and distribution**: zip packages with SHA-256, shared-folder and HTTP sources
  with an `index.json`, update checks and rollback. Zip handling uses only `node:zlib`.

Types for plugin authors: `@spica/plugins/types`.

```sh
npm test                                     # from the repository root
npm run smoke:plugins -w @spica/plugins      # J6: install the example plugin, call a tool, disable it
```

Design notes (Chinese): `docs/design/plugins.md`. Author guide (Chinese): `docs/plugins/authoring.md`.
