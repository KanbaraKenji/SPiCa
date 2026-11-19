import { describe, expect, it } from 'vitest';
import { HIDDEN, maskBody, maskHeaders, maskUrl } from './mask';

describe('mask: sign-in data hidden before the model reads a request', () => {
  it('headers: cookies, Authorization and token-like names hidden, the rest kept', () => {
    expect(
      maskHeaders({ Cookie: 'sid=1', 'Set-Cookie': 'a=b', Authorization: 'Bearer x', 'Proxy-Authorization': 'Basic y', 'X-API-Key': 'k', 'X-CSRF-Token': 't', Accept: 'text/html', 'Content-Type': 'application/json' }),
    ).toEqual({ Cookie: HIDDEN, 'Set-Cookie': HIDDEN, Authorization: HIDDEN, 'Proxy-Authorization': HIDDEN, 'X-API-Key': HIDDEN, 'X-CSRF-Token': HIDDEN, Accept: 'text/html', 'Content-Type': 'application/json' });
  });
  it('addresses: token-like query values, the hash after a sign-in and a user name / password', () => {
    expect(maskUrl('https://api.example.com/v1/items?page=2&access_token=abc123&api_key=zz')).toBe(`https://api.example.com/v1/items?page=2&access_token=${HIDDEN}&api_key=${HIDDEN}`);
    expect(maskUrl('https://example.com/cb#access_token=abc&state=1')).toBe(`https://example.com/cb#access_token=${HIDDEN}&state=1`);
    expect(maskUrl('https://alex:secret@example.com/')).toBe('https://hidden:hidden@example.com/');
    expect(maskUrl('https://example.com/search?q=shoes')).toBe('https://example.com/search?q=shoes');
  });
  it('bodies: JSON fields, form fields, Bearer tokens', () => {
    expect(JSON.parse(maskBody('{"user":"ALEX.CHEN","password":"p","nested":{"refresh_token":"r","n":1}}', 'application/json'))).toEqual({ user: 'ALEX.CHEN', password: HIDDEN, nested: { refresh_token: HIDDEN, n: 1 } });
    expect(maskBody('username=alex&password=hunter2&remember=1', 'application/x-www-form-urlencoded')).toBe(`username=alex&password=${HIDDEN}&remember=1`);
    expect(maskBody('header: Bearer abcdefghijklmnop')).toBe(`header: Bearer ${HIDDEN}`);
    expect(maskBody('<p>"session_id": "zzz" and token=abc</p>')).toBe(`<p>"session_id": "${HIDDEN}" and token=${HIDDEN}</p>`);
  });
});
