import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICES } from '@spica/core';
import { emptyDraft } from '../../shared/providers';
import { knownContextWindow, toProviderConfig } from './to-config';

const saved = { ...emptyDraft('wso2'), id: 'gw', name: '网关', baseUrl: 'https://gw/v1', tokenUrl: 'https://gw/token', clientId: 'c', model: 'claude-sonnet-5-5', secret: 's' };

describe('toProviderConfig', () => {
  it('sends 上下文上限 for the model of the entry', () => {
    expect(toProviderConfig({ ...saved, contextWindow: 200_000 }).contextWindows).toEqual({ 'claude-sonnet-5-5': 200_000 });
  });

  it('sends none when the entry has none (older settings)', () => {
    expect(toProviderConfig({ ...saved, contextWindow: null })).not.toHaveProperty('contextWindows');
  });
});

describe('knownContextWindow', () => {
  it('knows a model behind a gateway by its exact name, and nothing from a * row', () => {
    expect(knownContextWindow(DEFAULT_PRICES, 'wso2', 'claude-sonnet-5-5')).toBe(1_000_000);
    expect(knownContextWindow(DEFAULT_PRICES, 'openai-compatible', 'nobody-knows-this')).toBeNull();
    expect(knownContextWindow(DEFAULT_PRICES, 'anthropic', 'claude-unknown')).toBeNull();
  });
});
