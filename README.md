<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/resources/branding/svg/spica-banner-dark.svg">
    <img alt="Spica" src="apps/desktop/resources/branding/svg/spica-banner-light.svg" height="64">
  </picture>
</p>

<p align="center">
  An open-source desktop agent workbench for Windows: your own small team of AI agents
  that keeps multi-stage work moving.
</p>

<p align="center">
  <img alt="Spica, light" src="docs/screenshots/shell/light-1280x800-z100.png" width="49%">
  <img alt="Spica, dark" src="docs/screenshots/shell/dark-1280x800-z100.png" width="49%">
</p>

## What it is

Spica is built for people who work with outside parties and push work through internal
stages, not for developers only. It gives you a personal team:

- a **top-level agent** that knows every project and can start new ones,
- a **project-manager agent** per project, bound to the project's folder,
- **sub-agents** the manager opens for separate tasks. You can step into any of them and
  change direction; the manager sees what you said and decided there.

Around that team:

- **API first.** Every feature is a backend API; the window is one client of it and
  Spica's own MCP service is another, so scripts and evaluations drive the same agents.
- **Files.** Agents read PDF, Word and Excel files and answer with file cards.
- **Mail.** Incoming mail can be sorted into projects; the project's manager suggests what
  to do next. Irreversible actions (sending mail, writing to other systems) ask first.
- **Plugins.** Skills, commands, MCP servers and code hooks in one folder; disabling a
  plugin withdraws everything it registered.
- **Models.** Any OpenAI-compatible endpoint (including LiteLLM proxies), the Anthropic
  API, or a WSO2 API gateway. Spica can be set up to run entirely inside a private
  network.
- **Locked-down PCs.** Installs per user without administrator rights, depends on nothing
  preinstalled, and never pops up a console window.

## Quick start

The interface is in Chinese for now; menu names are given in both languages below.

### Install from a release

1. Open the [Releases](https://github.com/KanbaraKenji/SPiCa/releases) page and pick the
   newest release (early builds are marked *Pre-release*).
2. Download one of:
   - `Spica-Setup-<version>.exe`: installs for the current user only
     (`%LOCALAPPDATA%\Programs\Spica`), no administrator rights needed;
   - `Spica-Portable-<version>.exe`: runs without installing.
3. The builds are not code-signed yet, so Windows may show "Windows protected your PC".
   Choose **More info › Run anyway**.
4. Add a model under **Settings › Models** (设置 › 模型).

### Install the official plugins

Each release also carries the official plugins as zips, each with a `.sha256` file, and an
`index.json` that lists them all.

- **All at once (checksums checked):** open **Settings › Plugins › Market** (设置 › 插件 ›
  市场), press **Add source** (添加来源), paste the release's `index.json` address and press
  **Add** (添加):

  ```
  https://github.com/KanbaraKenji/SPiCa/releases/download/<tag>/index.json
  ```

  The plugins in that release are listed under the source, each marked installed (已安装),
  update available (可更新) or not; pick one and press **Install** (安装). Spica checks each package's SHA-256 before installing. The exact address is also in
  the release notes. The source stays in the list, so **Check for updates** (检查更新) next to
  it looks for newer versions later.
- **One zip:** download for example `outlook-<version>.zip`, then under **Add source** paste
  the zip's full path (or pick its folder with the folder button) and press **Add**; the
  plugin is listed below to install. A zip's web address works too: it is not kept as a
  source, but the plugin is listed below to install. To check a download first:
  `certutil -hashfile outlook-<version>.zip SHA256` and compare with the `.sha256` file.

| Plugin | What it does |
| --- | --- |
| `outlook` | Reads mail from the classic Outlook desktop app, helps sort it into projects and drafts replies; never sends. Turn on mock mode (模拟模式) to try it with a fictional mailbox |
| `notes` | Example plugin: a local notebook and a fictional sample catalog; shows every part of a plugin |

The evaluation template in `plugins/example-eval` is for developers and is not shipped
with releases.

### Run from source

Requirements: Windows 10 or 11 and Node.js 24. No administrator rights needed.

```sh
git clone https://github.com/KanbaraKenji/SPiCa.git
cd SPiCa
npm install
npm run dev
```

The first `npm run dev` downloads the Electron runtime (about 100 MB) once. When the
window opens, add a model under **Settings › Models** (设置 › 模型).

#### A company gateway in the development build

The development build connects to a company gateway (WSO2) the same way the installed
app does; a few things differ in where its settings come from.

- `.env.local` holds only an OpenAI-compatible or Anthropic model (shown as
  开发用模型（.env.local）). Add the gateway under **Settings › Models › 添加服务商 ›
  公司网关（WSO2）** and check it with **测试连接**.
- The `.env.local` model stays the default until you change **默认模型** on that page, or
  pick the gateway's model with the model button under the message box.
- With `SPICA_USER_DATA=<folder>` the build keeps its own settings folder. Keys saved in
  another folder cannot be opened there (Windows seals them with a key kept in that
  folder's `Local State`): enter the Consumer Secret again and save. The connection then
  shows no problem line.
- When **Settings › General › 代理地址** is empty, the app uses `HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY` from the environment it was started in; for `npm run dev`
  that is your terminal, which may differ from what the Start menu gives the installed
  app. The line under the network settings (当前：…) shows the proxy in force. If the
  gateway is only reachable directly, add its host to `NO_PROXY` in that terminal, or
  fill in 代理地址 and 不使用代理的地址 on the settings page.
- If a model call fails, the reason shows under your message. If a tool call fails, its
  row in the conversation says 失败; click the row for the reason (for example a wrong
  argument or an unknown tool name).

## Architecture

<p align="center">
  <img alt="Spica architecture" src="docs/architecture.svg" width="100%">
</p>

- `apps/desktop` is the Electron app. The agent core runs in its own backend process, so a
  crash there never takes the window down.
- `packages/core` is the agent core: the agent loop, built-in tools, the three-level team,
  model providers and Spica's MCP service. It has no runtime dependencies beyond Node.
- `packages/extract` reads documents, `packages/plugins` installs and runs plugins,
  `packages/brand` draws the mark and the splash, and `packages/protocol` holds the API
  and event types every part shares.
- `plugins/` holds the official plugins: `example-notes` and `outlook-mail`.

Design documents are in Chinese; start at [docs/README.md](docs/README.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the desktop app in development mode |
| `npm run build` | Build the desktop app bundles |
| `npm run dist` | Build the per-user installer and the portable exe into `apps/desktop/release/` |
| `npm run lint` | ESLint over the whole repository |
| `npm run typecheck` | TypeScript type check for every workspace |
| `npm test` | Unit and integration tests (Vitest, fake model gateway, no keys needed) |
| `npm run scan:sensitive` | Scan the repository for sensitive words |
| `npm run acceptance` | Run the automated acceptance journeys and write a summary |
| `npm run pack:plugins` | Pack the official plugins into zips with SHA-256 files and `index.json` (`out/plugins/`) |
| `npm run release:prepare -- <version>` | Set the version, commit and tag a release (does not push) |

## Acceptance journeys

The first release is judged by eight user journeys. J2–J7 run automatically through
Spica's MCP service with a real model; J8 is a screenshot matrix; J1 is checked by hand.

| Journey | What is checked | How to run |
| --- | --- | --- |
| J1 Install and start | Installs without admin rights, splash plays, first reply streams | By hand, with `npm run dist` |
| J2 Read files | The top-level agent answers from PDF / Word / Excel files, with file cards | `npm run journeys` |
| J3 Create a project | A project with a manager, two sub-agents in parallel, then a summary | `npm run journeys` |
| J4 Step in | You change direction inside a sub-agent; the manager's summary reflects it | `npm run journeys` |
| J5 Ask and confirm | A question card, then a confirmation before an irreversible action | `npm run journeys` |
| J6 Plugins | Install a plugin, its tools work at once, disable it and they are gone | `npm run journey:j6` |
| J7 Recover | Close or kill the app mid-run; conversations, projects and sub-agents survive | `npm run journeys` |
| J8 Looks | Light and dark, four window sizes, 100% and 150% zoom | `npm run shots` |

`npm run acceptance` runs all three commands in turn and saves a summary to
`out/acceptance/`; `npm run acceptance -- --only j6,shots` runs some of them.

The model journeys need a `.env.local` at the repository root (copy `.env.example`): an
OpenAI-compatible endpoint, key and model. A full run costs a few cents.
`npm run shots` rewrites the images in `docs/screenshots/shell/`.

## Writing a plugin

A plugin is a folder with a `manifest.json` and any of skills, commands, MCP servers,
hooks and views. Start with the [plugin author guide](docs/plugins/authoring.md) (in
Chinese) and the working example in [plugins/example-notes](plugins/example-notes).

To let Claude Code or Codex build and install plugins for you, copy the folder
[skills/spica-plugin-author](skills/spica-plugin-author) to `~/.claude/skills/` (Claude Code)
or `~/.codex/skills/` (Codex), then ask it to "make a Spica plugin that …".

## Known issues

- On Windows with the system Node 24.15, aborting a streaming HTTP request occasionally
  crashes the process natively (exit code `0xC0000409`) during tests or smoke runs — not
  an assertion failure, a rerun passes; the core avoids it by cancelling the reader
  instead of aborting the connection when the user stops, and the Node bundled with the
  Spica desktop app (Electron 45, Node 24.22.2) does not reproduce it (see
  [docs/design/agent-core.md](docs/design/agent-core.md) §20). CI retries the test step
  once for this reason.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
