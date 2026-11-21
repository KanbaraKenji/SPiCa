import { describe, expect, it } from 'vitest';
import { commandLine, draftArgs, emptyMcpDraft, keyOf, mcpDraftErrors, mcpProblemText, parseMcpPaste, quoteArg } from './mcp-servers';
import { setLocale } from './i18n';

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
  it('a web address: https, or http on this computer; headers not twice, nor Authorization beside the key', () => {
    const w = { ...emptyMcpDraft(), name: 'docs', kind: 'url' as const };
    expect(mcpDraftErrors({ ...w, url: '' }, []).url).toBe('必填');
    expect(mcpDraftErrors({ ...w, url: 'mcp.example.com' }, []).url).toBe('网址无效');
    expect(mcpDraftErrors({ ...w, url: 'http://mcp.example.com/mcp' }, []).url).toBe('只支持 https（本机地址可用 http）');
    expect(mcpDraftErrors({ ...w, url: 'http://127.0.0.1:8931/mcp' }, [])).toEqual({});
    expect(mcpDraftErrors({ ...w, url: 'https://mcp.example.com/mcp' }, [])).toEqual({});
    expect(mcpDraftErrors({ ...w, url: 'https://x.example.com', headers: [{ name: 'X-A' }, { name: 'x-a' }] }, []).headers).toContain('x-a');
    expect(mcpDraftErrors({ ...w, url: 'https://x.example.com', key: 'k', headers: [{ name: 'Authorization' }] }, []).headers).toBe('「Authorization」与「密钥」重复');
    expect(mcpDraftErrors({ ...w, url: 'https://x.example.com', headers: [{ name: 'Bad Name' }] }, []).headers).toBeTruthy();
    expect(keyOf(' Bearer abc ')).toBe('abc');
  });
  it('says a variable named twice', () => {
    expect(mcpDraftErrors({ ...d, env: [{ name: 'A' }, { name: 'a' }] }, []).env).toContain('a');
  });
});

describe('parseMcpPaste', () => {
  it('reads mcpServers: local programs and web addresses (a Bearer Authorization is the key, other headers stay headers)', () => {
    const r = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          files: { command: 'npx', args: ['-y', '@example/files'], env: { TOKEN: 'x' } },
          web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ex-key-1', 'X-Team': 'docs' } },
          old: { type: 'sse', url: 'https://mcp.example.com/sse' },
          gem: { httpUrl: 'https://mcp.example.com/g', headers: { Authorization: 'Basic eDp5' } },
        },
      }),
    );
    expect(r?.servers).toEqual([
      { name: 'files', command: 'npx', args: ['-y', '@example/files'], env: [{ name: 'TOKEN', value: 'x' }] },
      { name: 'web', command: '', args: [], env: [], url: 'https://mcp.example.com/mcp', key: 'ex-key-1', headers: [{ name: 'X-Team', value: 'docs' }] },
      { name: 'old', command: '', args: [], env: [], url: 'https://mcp.example.com/sse', headers: [] },
      { name: 'gem', command: '', args: [], env: [], url: 'https://mcp.example.com/g', headers: [{ name: 'Authorization', value: 'Basic eDp5' }] },
    ]);
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

describe("why a service stopped, in the interface's words", () => {
  it('says what is missing and what it belongs to; the rest plainly', () => {
    expect(mcpProblemText({ kind: 'not-found', command: 'C:\\Program Files\\nodejs\\npx.cmd' })).toBe('找不到命令「npx」（需要 Node.js）');
    expect(mcpProblemText({ kind: 'not-found', command: 'my-server' })).toBe('找不到命令「my-server」');
    expect(mcpProblemText({ kind: 'exited', code: 1 })).toBe('进程已退出（代码 1）');
    expect(mcpProblemText({ kind: 'timeout', seconds: 60 })).toBe('连接超时（60 秒内无响应）');
    expect(mcpProblemText({ kind: 'crash-loop', count: 4, seconds: 60 })).toBe('60 秒内崩溃 4 次，已停止重启');
    expect(mcpProblemText({ kind: 'version', versions: ['2027-01-01'] })).toBe('版本不兼容（服务仅支持 2027-01-01）');
    expect(mcpProblemText({ kind: 'unreachable' })).toBe('无法打开网址');
    expect(mcpProblemText({ kind: 'unreachable', status: 404 })).toBe('无法打开网址（HTTP 404）');
    expect(mcpProblemText({ kind: 'needs-key' })).toBe('需要密钥');
    expect(mcpProblemText({ kind: 'bad-key' })).toBe('密钥无效');
    expect(mcpProblemText({ kind: 'certificate', reason: 'untrusted' })).toBe('证书不受信任');
    setLocale('en');
    try {
      expect(mcpProblemText({ kind: 'not-found', command: 'node' })).toBe('Command “node” not found (Node.js needed)');
    } finally {
      setLocale('zh-CN');
    }
  });
});
