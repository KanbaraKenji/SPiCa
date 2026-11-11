import { describe, expect, it } from 'vitest';
import { flowFile } from './flow-scheme';

describe('spica-flow: the flowchart frame’s files', () => {
  it('serves flow.html and the built scripts and styles', () => {
    expect(flowFile('spica-flow://app/flow.html')).toBe('flow.html');
    expect(flowFile('spica-flow://app/assets/flow-hDwTcnhm.js')).toBe('assets/flow-hDwTcnhm.js');
    expect(flowFile('spica-flow://app/assets/index-1.css')).toBe('assets/index-1.css');
  });

  it('nothing else, and nothing outside the renderer folder', () => {
    for (const url of [
      'spica-flow://app/index.html',
      'spica-flow://app/../main/index.js',
      'spica-flow://app/assets/..%2F..%2Fmain%2Findex.js',
      'spica-flow://app/assets/x.png',
      'spica-flow://app/assets/sub/x.js',
      'spica-flow://other/flow.html',
      'spica-file://app/flow.html',
      'spica-flow://app/assets%5Cx.js',
      'not a url',
    ])
      expect(flowFile(url), url).toBeNull();
  });
});
