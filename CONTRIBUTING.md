# Contributing to Spica

Thanks for helping. This page lists the few rules that keep the repository easy to work in.

## Before you commit

Run the same checks CI runs:

```sh
npm run lint
npm run typecheck
npm test
npm run scan:sensitive
```

All four must pass. `npm test` needs no model keys; it uses a fake model gateway.

## Commits

- **Messages in English.** A short summary line in the imperative ("Add …", "Fix …"),
  at most about 72 characters, then a blank line and a body that says *why* when it is
  not obvious.
- **One topic per commit.** Do not mix a refactor, a feature and a version bump.
- **Plain git.** Stage only your own paths and commit from a message file:

  ```sh
  git add path/to/your/files
  git commit -F message.txt
  ```

  Several people (and agents) may work in the same tree at once, so never use
  `git add -A` or `git add .`, and never commit files you did not change.
- **History is append-only.** No `--amend`, rebase or force-push on commits others may
  have; fix mistakes with a new commit.

## Dependencies and the lockfile

- Pin exact versions (`"1.2.3"`, not `"^1.2.3"`).
- `package-lock.json` goes into the **same commit** as the `package.json` change that
  caused it. Whoever changes a dependency commits the lockfile; nobody else touches it.
- Prefer Node built-ins over new dependencies. Runtime dependencies must have a
  permissive license (MIT, Apache-2.0, BSD, ISC, …); note anything bundled in `NOTICE`.
- Never install anything globally; every tool is a devDependency used through `npm run`.

## Language

- README, code comments, commit messages and English user docs: **English**.
- Design documents under `docs/design/`: **Chinese**. An index is in
  [docs/README.md](docs/README.md).

## Content rules

- Examples, documentation and test data use generic or fictional scenarios only. No
  company names, customers, internal hosts or industry-specific material.
- Framework code must hold for any company. Company differences belong in data or in a
  plugin, never in an `if` inside the framework.
- Model keys never enter the repository. Put them in `.env.local` (ignored by git); the
  variable names are in `.env.example`.
- Keep large review media (videos, comparison sets) out of the repository; commit only
  final assets and a few key stills.

## Sensitive-word scan

`npm run scan:sensitive` scans every tracked and new file. The repository ships only
generic example words (`scripts/sensitive-words/words.example.txt`). A private fork adds
its own list with the `SPICA_SENSITIVE_WORDS` environment variable (file paths), the
`--words <path>` option, or the `SPICA_SENSITIVE_WORDS_LIST` repository secret in CI.
A hit fails with the file and line; the word itself is never printed.

## Windows rules

- Any child process (`spawn`, `execFile`, `fork`, …) uses `windowsHide: true`; no
  `shell: true`. Users never see a console window.
- Nothing may require administrator rights or a preinstalled component.

## Releases

1. `npm run release:prepare -- 0.2.0` sets the version, commits it and creates the tag
   `v0.2.0` locally. Any exact version works, including prereleases (`0.2.0-rc.1`) and
   going from a prerelease to the final release. `patch` / `minor` / `major` count up
   from a plain `x.y.z` only.
2. Pushing the tag (`git push origin main v0.2.0`) runs
   `.github/workflows/release.yml`, which builds the per-user installer and the portable
   exe on Windows, packs the official plugins in `plugins/` (`npm run pack:plugins`: zip,
   `.sha256` and `index.json`) and publishes them all as a GitHub Release.

To try the build without publishing anything, push a branch whose name starts with
`ci/release-dryrun`: the same workflow runs and the packages are attached to the run as
artifacts (kept for 7 days) instead of a Release.

## License

By contributing you agree that your contributions are licensed under the Apache License
2.0, and you confirm the work is your own and contains no confidential information.
