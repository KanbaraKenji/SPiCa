import { describe, expect, it } from 'vitest';
import { asFacts, fingerprint, judge, sensitiveField, shortSite, type ElementFacts } from './actions';

const el = (over: Partial<ElementFacts> = {}): ElementFacts => ({ found: true, tag: 'button', type: 'button', role: '', name: 'Next', autocomplete: '', fieldName: '', editable: false, page: 'https://shop.example/cart', x: 1, y: 1, ...over });
const form = { action: 'https://shop.example/order', method: 'post' };

describe('judge: the confirmation table', () => {
  it('links, ordinary buttons and typing into an ordinary field: done at once', () => {
    expect(judge('browser_click', el({ tag: 'a', name: 'Delete this page?', href: 'https://shop.example/help' }))).toEqual({ action: 'allow' });
    expect(judge('browser_click', el())).toEqual({ action: 'allow' });
    expect(judge('browser_type', el({ tag: 'input', type: 'text', name: 'Search', editable: true }))).toEqual({ action: 'allow' });
    expect(judge('browser_press', el({ tag: 'input', type: 'text' }), { key: 'Tab' })).toEqual({ action: 'allow' });
  });

  it('submitting a form: asked, naming the site it goes to and the button as the page words it', () => {
    expect(judge('browser_click', el({ type: 'submit', name: 'Place order', form }))).toEqual({ action: 'confirm', reason: '提交表单\nshop.example · 「Place order」' });
    expect(judge('browser_click', el({ tag: 'input', type: 'submit', name: 'Go' }))).toMatchObject({ action: 'confirm' });
    expect(judge('browser_type', el({ tag: 'input', type: 'text', name: '收货人', editable: true, form }), { submit: true, text: '张三' })).toEqual({ action: 'confirm', reason: '填入并提交\nshop.example · 「收货人」：「张三」' });
    expect(judge('browser_press', el({ tag: 'input', form }), { key: 'Enter' })).toEqual({ action: 'confirm', reason: '提交表单\nshop.example' });
  });

  it('a button outside a form whose words pay, order, send or delete: asked', () => {
    for (const name of ['Pay now', 'Buy', 'Send', '删除', '立即付款', '提交订单', 'Confirm transfer']) expect(judge('browser_click', el({ name })).action).toBe('confirm');
  });

  it('a download link: asked', () => {
    expect(judge('browser_click', el({ tag: 'a', name: 'Report', href: 'https://files.example/r.pdf', download: true }))).toEqual({ action: 'confirm', reason: '下载\nfiles.example · 「Report」' });
  });

  it('password, card and code fields: left to the person, whatever the approval mode', () => {
    for (const f of [el({ tag: 'input', type: 'password', editable: true }), el({ tag: 'input', type: 'text', autocomplete: 'cc-number', editable: true }), el({ tag: 'input', type: 'text', autocomplete: 'one-time-code', editable: true }), el({ tag: 'input', type: 'tel', fieldName: 'cvv ', editable: true }), el({ tag: 'input', type: 'text', name: '短信验证码', editable: true })])
      expect(judge('browser_type', f).action).toBe('deny');
  });

  it('a long button name is cut on the card; an element not there is left to the tool', () => {
    const r = judge('browser_click', el({ type: 'submit', form, name: 'x'.repeat(50) }));
    expect(r.action === 'confirm' && r.reason).toBe(`提交表单\nshop.example · 「${'x'.repeat(30)}…」`);
    expect(judge('browser_click', null)).toEqual({ action: 'allow' });
    expect(judge('browser_click', el({ found: false }))).toEqual({ action: 'allow' });
  });
});

it('sensitiveField', () => {
  expect(sensitiveField(el({ type: 'password' }))).toBe(true);
  expect(sensitiveField(el({ type: 'text', fieldName: 'username' }))).toBe(false);
  expect(sensitiveField(el({ type: 'text', fieldName: 'card_number' }))).toBe(true);
});

it('fingerprint: what was asked about, by its words, form and site', () => {
  const a = el({ type: 'submit', name: 'Place order', form });
  expect(fingerprint(a)).toBe(fingerprint({ ...a, x: 99 }));
  expect(fingerprint(a)).not.toBe(fingerprint({ ...a, name: 'Delete account' }));
  expect(fingerprint(a)).not.toBe(fingerprint({ ...a, form: { ...form, action: 'https://evil.example/' } }));
});

it('asFacts: the shape only', () => {
  expect(asFacts(null)).toBeNull();
  expect(asFacts({ found: false, page: 'p' })).toMatchObject({ found: false, page: 'p' });
  expect(asFacts({ found: true, tag: 'a', href: 'h', download: true, x: '5' })).toMatchObject({ found: true, tag: 'a', href: 'h', download: true, x: 5 });
});

it('shortSite: a long host cut in the middle, so the button after it still shows', () => {
  expect(shortSite('shop.example')).toBe('shop.example');
  expect(shortSite('procurement-contracts-portal.example-manufacturing-group.com:47841')).toBe('procurement-cont…ng-group.com:47841');
  const r = judge('browser_click', el({ type: 'submit', name: '确认提交', form: { action: 'https://procurement-contracts-portal.example-manufacturing-group.com/submit', method: 'post' } }));
  expect(r.action === 'confirm' && r.reason).toBe('提交表单\nprocurement-cont…acturing-group.com · 「确认提交」');
});