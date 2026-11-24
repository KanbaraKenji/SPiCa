import { describe, expect, it } from 'vitest';
import { humanOnly, type DelegateQuery } from './delegate-confirm.ts';

const base: DelegateQuery = { step: false, outsideContent: false };
const plainCommand = { danger: false, installs: false, downloads: false };

describe('humanOnly', () => {
  it('leaves to the manager: a plain command in Manual, a write outside the folders, a read in another project, a user-added MCP tool', () => {
    expect(humanOnly({ ...base, byDefault: true, command: plainCommand })).toBeUndefined();
    expect(humanOnly({ ...base, cause: 'outside_folder' })).toBeUndefined();
    expect(humanOnly({ ...base, cause: 'other_project' })).toBeUndefined();
    expect(humanOnly({ ...base, hookDelegable: true })).toBeUndefined();
  });

  it('keeps with the user whatever a step of a running call asks (one of a batch)', () => {
    expect(humanOnly({ ...base, step: true, byDefault: true, command: plainCommand })).toBe('step');
  });

  it('keeps with the user anything asked while the conversation acts on outside content', () => {
    expect(humanOnly({ ...base, outsideContent: true, cause: 'outside_folder' })).toBe('outside_content');
    expect(humanOnly({ ...base, cause: 'untrusted_turn' })).toBe('guard');
    expect(humanOnly({ ...base, cause: 'outside_link' })).toBe('guard');
    expect(humanOnly({ ...base, cause: 'sensitive_file' })).toBe('guard');
  });

  it('keeps with the user 无法撤销: marked by a hook or plugin, or a dangerous command', () => {
    expect(humanOnly({ ...base, hookDelegable: true, irreversible: true })).toBe('irreversible');
    expect(humanOnly({ ...base, byDefault: true, command: { ...plainCommand, danger: true } })).toBe('irreversible');
  });

  it('keeps with the user installs and downloads', () => {
    expect(humanOnly({ ...base, cause: 'python_install', install: true })).toBe('install');
    expect(humanOnly({ ...base, byDefault: true, command: { ...plainCommand, installs: true } })).toBe('install');
    expect(humanOnly({ ...base, byDefault: true, command: { ...plainCommand, downloads: true } })).toBe('install');
  });

  it('keeps with the user a folder where only 允许 is offered (a drive root, the home folder)', () => {
    expect(humanOnly({ ...base, cause: 'outside_folder', folderTooWide: true })).toBe('too_wide');
  });

  it('keeps with the user a tool that says so (操作电脑, scheduled tasks)', () => {
    expect(humanOnly({ ...base, byDefault: true, toolHumanOnly: true })).toBe('tool');
  });

  it('keeps with the user any source not on the list: a hook that did not say, a plugin view, a settings change', () => {
    expect(humanOnly({ ...base })).toBe('source');
    expect(humanOnly({ ...base, cause: 'plugin_view' })).toBe('source');
    expect(humanOnly({ ...base, cause: 'settings_change' })).toBe('source');
  });
});
