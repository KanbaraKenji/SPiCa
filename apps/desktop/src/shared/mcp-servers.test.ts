import { describe, expect, it } from 'vitest';
import { commandLine, draftArgs, emptyMcpDraft, mcpDraftErrors, parseMcpPaste, quoteArg } from './mcp-servers';

describe('commandLine', () => {
  it('quotes what has a space or a quote, and nothing else', () => {
    expect(commandLine('npx', ['-y', '@example/files', 'D:\\Shared Files'])).toBe('npx -y @example/files "D:\\Shared Files"');
    expect(quoteArg('')).toBe('""');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg('D:\\a b\\')).toBe('"D:\\a b\\\\"');
    expect(quoteArg('a&b')).toBe('a&b');
  });
});

describe('draftArgs', () => {
  it('is one argument a line, kept as it is', () => {
    expect(draftArgs({ args: '-y\r\n\n@example/files\n  D:\\Shared Files  ' })).toEqual(['-y', '@example/files', '  D:\\Shared Files  ']);
  });
});

describe('mcpDraftErrors', () => {
  const d = { ...emptyMcpDraft(), name: 'files', command: 'npx' };
  it('needs a name and a command', () => {
    expect(mcpDraftErrors(emptyMcpDraft(), [])).toEqual({ name: '必填', command: '必填' });
    expect(mcpDraftErrors(d, [])).toEqual({});
  });
  it('takes letters, digits, _ and - only, and a name not in use', () => {
    expect(mcpDraftErrors({ ...d, name: 'my files' }, []).name).toBeTruthy();
    expect(mcpDraftErrors({ ...d, name: 'Files' }, ['files']).name).toBe('名称已被使用');
  });
  it('says a variable named twice', () => {
    expect(mcpDraftErrors({ ...d, env: [{ name: 'A' }, { name: 'a' }] }, []).env).toContain('a');
  });
});

describe('parseMcpPaste', () => {
  it('reads mcpServers: the local programs, and names the web ones it skips', () => {
    const r = parseMcpPaste(JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@example/files'], env: { TOKEN: 'x' } }, web: { url: 'https://example.com/mcp' } } }));
    expect(r).toEqual({ servers: [{ name: 'files', command: 'npx', args: ['-y', '@example/files'], env: [{ name: 'TOKEN', value: 'x' }] }], skipped: ['web'] });
  });
  it('reads one service, the inside of mcpServers, and VS Code servers', () => {
    expect(parseMcpPaste('{"command":"node","args":["s.js"]}')?.servers[0]).toEqual({ name: '', command: 'node', args: ['s.js'], env: [] });
    expect(parseMcpPaste('"files": {"command": "npx", "cwd": "D:\\\\x"},')?.servers[0]).toEqual({ name: 'files', command: 'npx', args: [], env: [], cwd: 'D:\\x' });
    expect(parseMcpPaste('{"servers":{"a":{"type":"stdio","command":"uvx","args":["pkg"]}}}')?.servers[0]?.command).toBe('uvx');
  });
  it('is null for anything else', () => {
    expect(parseMcpPaste('npx -y something')).toBeNull();
    expect(parseMcpPaste('{"a": 1}')).toBeNull();
  });
});
