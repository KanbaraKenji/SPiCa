import { describe, expect, it } from 'vitest';
import { parsePastedConfig } from './paste-config';

describe('粘贴配置', () => {
  it('reads a WSO2 .env block (comments, export, quotes) and knows it is WSO2', () => {
    const r = parsePastedConfig(`# from the admin
export ACME_CONSUMER_KEY="ck-123"
ACME_CONSUMER_SECRET='cs-456'   # keep it safe
ACME_TOKEN_URL=https://gw.example.com/oauth2/token
ACME_LLM_BASE=https://gw.example.com/llm/v1/chat/completions
MODEL_NAME=team/claude-sonnet-5-5
`);
    expect(r.kind).toBe('wso2');
    expect(r.fields).toEqual({
      clientId: 'ck-123',
      secret: 'cs-456',
      tokenUrl: 'https://gw.example.com/oauth2/token',
      baseUrl: 'https://gw.example.com/llm/v1',
      model: 'team/claude-sonnet-5-5',
    });
    expect(r.notes).toEqual(['已移除地址末尾的 /chat/completions']);
    expect(r.unknown).toEqual([]);
  });

  it('reads YAML-ish and PowerShell lines, and lists what it cannot place', () => {
    const r = parsePastedConfig(`Consumer Key: ck-1
$env:CLIENT_SECRET = "cs-1"
Token endpoint: https://gw.example.com:9443/oauth2/token
Gateway: https://gw.example.com:8243/llm/v1
Owner: someone in IT
负责人：信息部
模型名称：team/m-2
`);
    expect(r.fields).toMatchObject({ clientId: 'ck-1', secret: 'cs-1', tokenUrl: 'https://gw.example.com:9443/oauth2/token', baseUrl: 'https://gw.example.com:8243/llm/v1', model: 'team/m-2' });
    expect(r.unknown).toEqual(['Owner: someone in IT', '负责人：信息部']);
  });

  it('reads JSON, nested too', () => {
    const r = parsePastedConfig('{ "llm": { "base_url": "https://api.example.com/v1", "api_key": "sk-1", "model": "m-1" } }');
    expect(r.fields).toEqual({ baseUrl: 'https://api.example.com/v1', secret: 'sk-1', model: 'm-1' });
    expect(r.kind).toBeUndefined();
  });

  it('places addresses given on their own lines by what they look like', () => {
    const r = parsePastedConfig('https://gw.example.com/oauth2/token\nhttps://gw.example.com/llm/v1');
    expect(r.fields).toEqual({ tokenUrl: 'https://gw.example.com/oauth2/token', baseUrl: 'https://gw.example.com/llm/v1' });
  });

  it('a second value for the same field is listed, not overwritten', () => {
    const r = parsePastedConfig('API_KEY=a\nSECRET_KEY=b');
    expect(r.fields.secret).toBe('a');
    expect(r.unknown).toEqual(['SECRET_KEY=b']);
  });

  it('an address that is not a URL is not taken as one', () => {
    const r = parsePastedConfig('BASE_URL=see the wiki');
    expect(r.fields.baseUrl).toBeUndefined();
    expect(r.unknown).toEqual(['BASE_URL=see the wiki']);
  });
});
