import { describe, expect, it } from 'vitest';
import type { PluginView } from './plugin-view';
import { chosenPreviewPage, fileExtension, previewerId, previewKinds, previewPagesFor, sanitizePreviewers } from './previewers';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

const view = (over: Partial<PluginView>): PluginView => ({ plugin: 'office-preview', pluginTitle: 'Office 预览', id: 'docx', title: 'Word 原样预览', placement: 'preview', entry: 'ui/docx.html', tools: [], preview: { extensions: ['.docx', '.docm'], maxBytes: 1024 }, ...over });

describe('which preview shows a file', () => {
  const docx = view({});
  const panel = view({ id: 'notes', placement: 'panel', preview: undefined });
  const views = [docx, panel];

  it('a file’s kind: lower case with the dot', () => {
    expect(fileExtension('D:\\工作\\需求说明.DOCX')).toBe('.docx');
    expect(fileExtension('README')).toBe('');
    expect(fileExtension('a.b/c')).toBe('');
  });

  it('only preview pages that list the kind', () => {
    expect(previewPagesFor('.docx', views)).toEqual([docx]);
    expect(previewPagesFor('.xlsx', views)).toEqual([]);
    expect(previewPagesFor('', views)).toEqual([]);
  });

  it('the chosen page while it is there; the app’s own when none is chosen or its page is gone', () => {
    expect(chosenPreviewPage({ '.docx': previewerId(docx) }, '.docx', views)).toBe(docx);
    expect(chosenPreviewPage({}, '.docx', views)).toBeNull();
    expect(chosenPreviewPage({ '.docx': 'office-preview/docx' }, '.docx', [panel])).toBeNull();
    expect(chosenPreviewPage({ '.docx': 'office-preview/xlsx' }, '.docx', views)).toBeNull();
  });

  it('the kinds 文件预览 lists: from the pages and from the kept choices', () => {
    expect(previewKinds({ '.pptx': 'slides/pptx' }, views)).toEqual(['.docm', '.docx', '.pptx']);
  });

  it('settings keep { ".ext": "plugin/page" } and drop anything else', () => {
    expect(DEFAULT_SETTINGS.previewers).toEqual({});
    expect(sanitizePreviewers({ '.docx': 'office-preview/docx', '.XLSX': 'a/b', '.pdf': 5, docx: 'a/b', '.md': 'no-slash', '.csv': 'a/b/c' })).toEqual({ '.docx': 'office-preview/docx' });
    expect(sanitizePreviewers(['x'])).toEqual({});
    expect(sanitizeSettings({ previewers: { '.docx': 'office-preview/docx' } }).previewers).toEqual({ '.docx': 'office-preview/docx' });
  });
});
