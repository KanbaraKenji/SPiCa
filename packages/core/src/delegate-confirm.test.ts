import { describe, expect, it } from 'vitest';
import { humanOnly, type DelegateQuery } from './delegate-confirm.ts';
import { scheduleTaskTool } from './tools/schedule-tools.ts';

const base: DelegateQuery = { step: false, toolName: 'write_file' };
const plainCommand = { danger: false, installs: false, downloads: false };
const command: DelegateQuery = { ...base, toolName: 'run_command', byDefault: true, command: plainCommand };

describe('humanOnly', () => {
  it('goes through the review first: a plain command in Manual, a write outside the folders, a read in another project, a user-added MCP tool', () => {
    expect(humanOnly(command)).toBeUndefined();
    expect(humanOnly({ ...base, cause: 'outside_folder' })).toBeUndefined();
    expect(humanOnly({ ...base, toolName: 'read_file', cause: 'other_project' })).toBeUndefined();
    expect(humanOnly({ ...base, toolName: 'notes__add', hookDelegable: true })).toBeUndefined();
  });

  it('is reviewed after outside content too (the review never sees it; the guard still asks): a plain command, a write outside the folders', () => {
    expect(humanOnly({ ...command, cause: 'untrusted_turn' })).toBeUndefined();
    expect(humanOnly({ ...base, cause: 'outside_folder' })).toBeUndefined();
  });

  it('keeps with the user a link from outside content and a credential file', () => {
    expect(humanOnly({ ...base, cause: 'outside_link' })).toBe('guard');
    expect(humanOnly({ ...base, toolName: 'read_file', cause: 'sensitive_file' })).toBe('guard');
  });

  it('keeps with the user whatever a step of a running call asks (one of a batch)', () => {
    expect(humanOnly({ ...command, step: true })).toBe('step');
  });

  it('keeps with the user 无法撤销: marked by a hook or plugin, or a dangerous command', () => {
    expect(humanOnly({ ...base, hookDelegable: true, irreversible: true })).toBe('irreversible');
    expect(humanOnly({ ...command, command: { ...plainCommand, danger: true } })).toBe('irreversible');
  });

  it('keeps with the user installs and downloads', () => {
    expect(humanOnly({ ...base, toolName: 'python_env', cause: 'python_install', install: true })).toBe('install');
    expect(humanOnly({ ...command, command: { ...plainCommand, installs: true } })).toBe('install');
    expect(humanOnly({ ...command, command: { ...plainCommand, downloads: true } })).toBe('install');
  });

  it('keeps with the user a folder where only 允许 is offered (a drive root, the home folder)', () => {
    expect(humanOnly({ ...base, cause: 'outside_folder', folderTooWide: true })).toBe('too_wide');
  });

  it('keeps with the user a tool that says so (操作电脑, scheduled tasks)', () => {
    expect(humanOnly({ ...command, toolHumanOnly: true })).toBe('tool');
    expect(humanOnly({ ...base, toolName: 'schedule_task', toolHumanOnly: !!scheduleTaskTool.confirmByUser })).toBe('tool');
  });

  it("keeps with the user whatever a scheduled task's run asks, a command it could answer otherwise too", () => {
    expect(humanOnly({ ...command, scheduledRun: true })).toBe('scheduled');
    expect(humanOnly({ ...base, cause: 'outside_folder', scheduledRun: true })).toBe('scheduled');
  });

  it('keeps with the user an irreversible tool other than a command read by the card (JavaScript, an MCP tool marked destructive)', () => {
    expect(humanOnly({ ...base, toolName: 'run_javascript', byDefault: true })).toBe('source');
    expect(humanOnly({ ...base, toolName: 'files__delete', byDefault: true })).toBe('source');
    expect(humanOnly({ ...base, toolName: 'run_command', byDefault: true })).toBe('source');
    expect(humanOnly({ ...base, toolName: 'run_javascript', cause: 'untrusted_turn' })).toBe('source');
  });

  it('keeps with the user any source not on the list: a hook that did not say, a plugin view, a settings change', () => {
    expect(humanOnly({ ...base })).toBe('source');
    expect(humanOnly({ ...base, cause: 'plugin_view' })).toBe('source');
    expect(humanOnly({ ...base, cause: 'settings_change' })).toBe('source');
  });
});
