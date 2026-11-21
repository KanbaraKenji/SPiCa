import { describe, expect, it } from 'vitest';
import { mcpProblem } from './mcp-problem.ts';

describe('why a service is not running', () => {
  it('a command that is not on this computer, or a program its .cmd calls', () => {
    expect(mcpProblem('could not start MCP server "files": spawn npx ENOENT', [], 'npx')).toEqual({ kind: 'not-found', command: 'npx' });
    expect(mcpProblem('MCP server "files" exited (code 1)', ["'node' is not recognized as an internal or external command,"], 'npx')).toEqual({ kind: 'not-found', command: 'node' });
    expect(mcpProblem('MCP server "files" exited (code 9009)', ["'node' 不是内部或外部命令，也不是可运行的程序"], 'npx')).toEqual({ kind: 'not-found', command: 'node' });
  });

  it('no answer, a newer version, quit by itself, anything else', () => {
    expect(mcpProblem('MCP server "x" did not answer initialize within 60 s; it was told to stop', [], 'node')).toEqual({ kind: 'timeout', seconds: 60 });
    expect(mcpProblem('MCP server "x" supports only 2027-01-01, 2027-06-01; Spica speaks 2026-07-28 and 2025-06-18', [], 'node')).toEqual({ kind: 'version', versions: ['2027-01-01', '2027-06-01'] });
    expect(mcpProblem('MCP server "x" exited (code 1): Traceback …', [], 'uvx')).toEqual({ kind: 'exited', code: 1 });
    expect(mcpProblem('MCP server "x" exited (code unknown)', [], 'uvx')).toEqual({ kind: 'exited', code: null });
    expect(mcpProblem('something else', [], 'uvx')).toEqual({ kind: 'other' });
  });

  it('a web address: no key, a key not taken, not reachable, its certificate', () => {
    const http = (s: number) => `MCP server "x" answered HTTP ${s} to initialize`;
    expect(mcpProblem(http(401), [], '')).toEqual({ kind: 'needs-key' });
    expect(mcpProblem(http(401), [], '', { keyGiven: true })).toEqual({ kind: 'bad-key' });
    expect(mcpProblem(http(403), [], '', { keyGiven: true })).toEqual({ kind: 'bad-key' });
    expect(mcpProblem(http(404), [], '')).toEqual({ kind: 'unreachable', status: 404 });
    expect(mcpProblem('MCP server "x" could not be reached (net.dns): getaddrinfo ENOTFOUND mcp.example.com', [], '')).toEqual({ kind: 'unreachable' });
    expect(mcpProblem('MCP server "x" could not be reached (tls.untrusted): self-signed certificate', [], '')).toEqual({ kind: 'certificate', reason: 'untrusted' });
    expect(mcpProblem('MCP server "x" could not be reached (tls.expired): certificate has expired', [], '')).toEqual({ kind: 'certificate', reason: 'expired' });
    expect(mcpProblem('MCP server "x" could not be reached (tls.name_mismatch): …', [], '')).toEqual({ kind: 'certificate', reason: 'name' });
  });
});
