// deploy.json "python": a company's switches for the app's own Python.
import { describe, expect, it } from 'vitest';
import { deployPython, deployPythonProblems } from './python-deploy.ts';

describe('deploy.json "python"', () => {
  it('not written, or written empty: on, with the public sources', () => {
    expect(deployPython(undefined)).toEqual({ enabled: true });
    expect(deployPython({})).toEqual({ enabled: true });
    expect(deployPython({ python: { enabled: true, pythonMirror: '', packageIndex: '' } })).toEqual({ enabled: true });
    expect(deployPythonProblems(undefined)).toEqual([]);
  });

  it('switched off, or pointed at a company mirror and index', () => {
    expect(deployPython({ python: { enabled: false } })).toEqual({ enabled: false });
    expect(deployPython({ python: { pythonMirror: ' https://mirror.example.com/pbs ', packageIndex: 'https://pypi.example.com/simple' } })).toEqual({
      enabled: true,
      pythonMirror: 'https://mirror.example.com/pbs',
      packageIndex: 'https://pypi.example.com/simple',
    });
    expect(deployPythonProblems({ pythonMirror: 'file:///D:/mirror/pbs', '// note': 'x' })).toEqual([]);
  });

  it('what packaging stops on: wrong types, unknown keys, not an address, a login in the address', () => {
    expect(deployPythonProblems('on')).toHaveLength(1);
    expect(deployPythonProblems({ enabled: 'yes' })).toEqual(['python.enabled 要写 true 或 false。']);
    expect(deployPythonProblems({ mirror: 'https://x.example.com' })[0]).toContain('python.mirror 不认识');
    expect(deployPythonProblems({ packageIndex: 'pypi.example.com/simple' })[0]).toContain('不是地址');
    expect(deployPythonProblems({ packageIndex: 'ftp://pypi.example.com/simple' })[0]).toContain('要以 https://');
    expect(deployPythonProblems({ packageIndex: 'https://me:secret@pypi.example.com/simple' })[0]).toContain('不要写账号密码');
    // a section with problems counts as not written where the app reads it (packaging stops on it before)
    expect(deployPython({ python: { enabled: false, mirror: 'x' } })).toEqual({ enabled: true });
  });
});
