// python_env: the Agent asks for the app's own Python and the packages a task needs (python-env.ts). Before
// anything is downloaded the user confirms a card that says what, from where and how big (previewInstall; asked in
// auto mode too). When everything asked for is there already, it runs without asking and says how to call Python.
import { envPython, installPython, packageSpecProblem, planPackages, pythonDownload, pythonEnvStatus, PYPI_SIMPLE, UvError, type PythonEnvOptions, type PythonPackage } from '../python-env.ts';
import type { InstallPreview } from '../types.ts';
import type { Tool } from './types.ts';

export interface PythonToolOptions extends PythonEnvOptions {
  /** After an install (the runtimes the model is told about change). */
  onInstalled?(packages: PythonPackage[]): void;
}

function packagesOf(input: Record<string, unknown>): string[] {
  const p = input.packages;
  return Array.isArray(p) ? p.map((x) => String(x).trim()).filter(Boolean) : [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** What an install would download; undefined when the Python is there and so is every package asked for. */
export async function previewPythonInstall(opts: PythonEnvOptions, packages: string[], signal?: AbortSignal): Promise<InstallPreview | undefined> {
  const ready = pythonEnvStatus(opts.root).ready;
  const planned = await planPackages(opts, packages, signal);
  if (ready && planned.length === 0) return undefined;
  const preview: InstallPreview = { packages: planned, packageHost: hostOf(opts.packageIndex ?? PYPI_SIMPLE) };
  if (!ready) {
    const py = await pythonDownload(opts, signal).catch(() => undefined);
    preview.python = py
      ? { version: py.version, host: hostOf(py.url), ...(py.bytes ? { bytes: py.bytes } : {}) }
      : { version: opts.pythonVersion ?? '3.12', host: opts.pythonMirror ? hostOf(opts.pythonMirror) : 'releases.astral.sh' };
  }
  return preview;
}

export function createPythonTool(opts: PythonToolOptions): Tool {
  return {
    category: 'command',
    spec: {
      name: 'python_env',
      description:
        "Get the app's own Python (a standalone Python the app manages, separate from any Python on this computer) and install packages " +
        'into it, e.g. pandas or openpyxl. The user confirms each download first. Returns the python executable to run scripts with in ' +
        'run_command. For a computer without Python of its own: when this computer has Python, use that one. Packages are plain ' +
        'names with optional version conditions (pandas, numpy>=2).',
      inputSchema: {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string' }, description: 'Packages to install (none: only make sure Python is there).' },
        },
      },
    },
    async previewInstall(input) {
      const packages = packagesOf(input);
      // a request that would be refused asks nothing: execute says why
      if (packages.some((p) => packageSpecProblem(p))) return undefined;
      return previewPythonInstall(opts, packages);
    },
    async execute(input, ctx) {
      const packages = packagesOf(input);
      const bad = packages.map(packageSpecProblem).find(Boolean);
      if (bad) return { content: `${bad}. Give package names with optional version conditions only.`, isError: true };
      try {
        const installed = await installPython(opts, packages, { signal: ctx.signal });
        opts.onInstalled?.(installed);
        const st = pythonEnvStatus(opts.root);
        const list = installed.length ? installed.map((p) => `${p.name} ${p.version}`).join(', ') : 'none';
        return {
          content:
            `The app's Python${st.version ? ` ${st.version}` : ''} is ready: ${envPython(opts.root)}\n` +
            `Packages in it: ${list}.\n` +
            `Run scripts with it in run_command, e.g. & "${envPython(opts.root)}" script.py (it has no pip: add packages with python_env).`,
        };
      } catch (e) {
        const msg = e instanceof UvError ? e.message : String(e instanceof Error ? e.message : e);
        return { content: `Could not set up the app's Python: ${msg}`, isError: true };
      }
    },
  };
}
