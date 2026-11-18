import { describe, expect, it } from 'vitest';
import { missedDownload, packageOf, runnerLaunch, runnerOf } from './runner.ts';

describe('npx and uvx services', () => {
  it('knows npx and uvx however they are written', () => {
    expect(runnerOf('npx')).toBe('npx');
    expect(runnerOf('C:\\Program Files\\nodejs\\npx.cmd')).toBe('npx');
    expect(runnerOf('UVX.EXE')).toBe('uvx');
    expect(runnerOf('node')).toBeUndefined();
  });

  it('finds the package in the arguments', () => {
    expect(packageOf('npx', ['-y', '@example/files-server', 'D:\\Shared Files'])).toBe('@example/files-server');
    expect(packageOf('npx', ['--package', '@example/kit', 'kit-files'])).toBe('@example/kit');
    expect(packageOf('npx', ['-p=@example/kit', 'kit-files'])).toBe('@example/kit');
    expect(packageOf('uvx', ['--python', '3.12', 'example-notes==1.2', '--db', 'x'])).toBe('example-notes==1.2');
    expect(packageOf('uvx', ['--from', 'example-notes[all]', 'notes-server'])).toBe('example-notes[all]');
  });

  it('offline: npx may not install (and its -y is taken out); uvx gets --offline', () => {
    expect(runnerLaunch('npx', 'npx', ['-y', '@example/files'], { A: '1' }, { download: false, uvOnPath: false })).toEqual({
      command: 'npx',
      args: ['@example/files'],
      env: { A: '1', npm_config_yes: 'false', npm_config_prefer_offline: 'true' },
    });
    expect(runnerLaunch('npx', 'npx', ['-y', '@example/files'], {}, { download: true, uvOnPath: false })).toEqual({ command: 'npx', args: ['-y', '@example/files'], env: { npm_config_yes: 'true' } });
    expect(runnerLaunch('uvx', 'uvx', ['example-notes'], {}, { download: false, uvOnPath: true })).toEqual({ command: 'uvx', args: ['--offline', 'example-notes'], env: {} });
  });

  it('no uvx on the computer: the app\'s uv runs it, in the app\'s Python folder; Python downloads only once allowed', () => {
    const uv = { exe: 'D:\\Spica\\uv\\uv.exe', root: 'D:\\Spica\\python' };
    const off = runnerLaunch('uvx', 'uvx', ['example-notes'], { NOTES_TOKEN: 'x' }, { download: false, uv, uvOnPath: false });
    expect(off.command).toBe(uv.exe);
    expect(off.args).toEqual(['tool', 'run', '--offline', 'example-notes']);
    expect(off.env).toMatchObject({ UV_PYTHON_DOWNLOADS: 'manual', UV_PYTHON_PREFERENCE: 'only-managed', NOTES_TOKEN: 'x' });
    expect(off.env.UV_CACHE_DIR).toMatch(/python[\\/]cache$/);
    const on = runnerLaunch('uvx', 'uvx', ['example-notes'], {}, { download: true, uv, uvOnPath: false });
    expect(on.args).toEqual(['tool', 'run', 'example-notes']);
    expect(on.env.UV_PYTHON_DOWNLOADS).toBe('automatic');
  });

  it('tells a missing package from other failures', () => {
    expect(missedDownload('npx', 'npm error npx canceled due to missing packages and no YES option: ["@example/files@1.0.0"]')).toBe(true);
    expect(missedDownload('npx', 'Error: Cannot find module server.js')).toBe(false);
    expect(missedDownload('uvx', 'error: Network connectivity is disabled, but the requested data wasn\'t found in the cache')).toBe(true);
    expect(missedDownload('uvx', 'error: No interpreter found for Python >=3.10 in managed installations')).toBe(true);
    expect(missedDownload('uvx', 'FileNotFoundError: notes.db')).toBe(false);
  });
});
