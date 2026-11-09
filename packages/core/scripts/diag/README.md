# Native crash repro: aborting HTTP streams on Windows

Observed on Node 24.15.0 / Windows 11: a process that repeatedly aborts streaming
HTTP responses occasionally dies with exit code `0xC0000409` (no JS stack, no
crash report). It reproduces with plain `fetch` and with `node:http`, without any
Spica code. Measured roughly once per few thousand aborts under heavy churn.

Run from `packages/core` (spawns its own gateway process and stops it at the end):

```
node scripts/diag/compare-abort-crash.mjs
```

It prints one result per run for `fetch` and for `node:http` (`ok` or the exit
code). Let the machine idle a few minutes before and between runs: thousands of
short connections exhaust ephemeral ports, which shows up as `fetch failed`
(exit code 1), a different problem. Use this to re-check newer Node versions and
Electron's bundled Node, or to attach to an upstream report.
