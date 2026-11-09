import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORK, networkForCore, sanitizeSettings } from './settings';

describe('network settings', () => {
  it('passes the proxy, the hosts that skip it and the certificate to the core', () => {
    expect(networkForCore({ proxy: ' http://proxy.example.com:8080 ', noProxy: 'localhost, .corp.example.com，10.0.0.0/8', caFile: 'C:/ca.pem', useSystemCa: true })).toEqual({
      proxy: { url: 'http://proxy.example.com:8080', noProxy: ['localhost', '.corp.example.com', '10.0.0.0/8'] },
      caFile: 'C:/ca.pem',
      useSystemCa: true,
    });
  });

  it('an empty proxy leaves it to the environment; Windows certificates are on by default', () => {
    expect(networkForCore(DEFAULT_NETWORK)).toEqual({ caFile: null, useSystemCa: true });
    expect(sanitizeSettings({}).network).toEqual(DEFAULT_NETWORK);
    expect(sanitizeSettings({ network: { proxy: 42, useSystemCa: false } }).network).toEqual({ ...DEFAULT_NETWORK, useSystemCa: false });
  });
});
