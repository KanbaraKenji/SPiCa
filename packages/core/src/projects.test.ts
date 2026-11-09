// Workflow files and role templates.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflows, validateWorkflow } from './projects.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

const exampleDir = fileURLToPath(new URL('../examples/workflows/', import.meta.url));

describe('workflow files', () => {
  it('loads the shipped example', () => {
    const { workflows, errors } = loadWorkflows(exampleDir);
    expect(errors).toEqual([]);
    const w = workflows.get('product-development')!;
    expect(w.stages.map((s) => s.id)).toEqual(['sample', 'pilot', 'mass']);
    expect(w.objectLevels).toEqual([
      { id: 'product', name: 'Product' },
      { id: 'part', name: 'Part', parent: 'product' },
    ]);
  });

  it('reports broken files by name and keeps loading the others', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a-good.json'), JSON.stringify({ id: 'ok', name: 'OK', stages: [{ id: 's1' }] }));
      await writeFile(join(dir, 'b-bad-json.json'), '{ nope');
      await writeFile(join(dir, 'c-no-stages.json'), JSON.stringify({ id: 'x', name: 'X', stages: [] }));
      await writeFile(join(dir, 'd-dup.json'), JSON.stringify({ id: 'ok', name: 'again', stages: [{ id: 's' }] }));
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      const { workflows, errors } = loadWorkflows(dir);
      expect([...workflows.keys()]).toEqual(['ok']);
      expect(workflows.get('ok')!.stages[0]).toEqual({ id: 's1', name: 's1' });
      expect(errors).toHaveLength(3);
      expect(errors.join('\n')).toMatch(/b-bad-json\.json: not valid JSON/);
      expect(errors.join('\n')).toMatch(/c-no-stages\.json: "stages" must be a non-empty array/);
      expect(errors.join('\n')).toMatch(/d-dup\.json: id "ok" is already defined/);
    } finally {
      await cleanup();
    }
  });

  it('rejects duplicate stages, unknown parents and cycles in object levels', () => {
    const base = { id: 'w', name: 'W' };
    expect(() => validateWorkflow({ ...base, stages: [{ id: 'a' }, { id: 'a' }] }, 't')).toThrow(/used twice/);
    expect(() => validateWorkflow({ ...base, stages: [{ id: 'a' }], objectLevels: [{ id: 'x', parent: 'nope' }] }, 't')).toThrow(/unknown parent/);
    expect(() =>
      validateWorkflow({ ...base, stages: [{ id: 'a' }], objectLevels: [{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }] }, 't'),
    ).toThrow(/cycle/);
  });

  it('a missing folder is an error, not a crash', () => {
    const { workflows, errors } = loadWorkflows(join(exampleDir, 'does-not-exist'));
    expect(workflows.size).toBe(0);
    expect(errors[0]).toMatch(/workflows folder/);
  });
});

describe('role templates', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
  });
  afterEach(async () => {
    await gw.stop();
  });

  it('apply system prompt, role and tools; explicit fields win; deployment templates override', async () => {
    const rt = makeRuntime(gw, { templates: [{ id: 'project-manager', name: 'PM (custom)', role: 'manager', system: 'CUSTOM PM PROMPT', tools: ['read_file'] }] });
    const top = rt.createSession({ templateId: 'top' });
    expect(top.info()).toMatchObject({ role: 'top', templateId: 'top' });
    expect(top.config.system).toMatch(/top-level agent/);
    const pm = rt.createSession({ templateId: 'project-manager', parentId: top.id });
    expect(pm.config.system).toBe('CUSTOM PM PROMPT');
    expect(pm.config.tools).toEqual(['read_file']);
    expect(pm.info().role).toBe('manager');
    const explicit = rt.createSession({ templateId: 'top', system: 'MINE' });
    expect(explicit.config.system).toBe('MINE');
    expect(() => rt.createSession({ templateId: 'nope' })).toThrow(/unknown role template/);
  });

  it('sub-agents inherit the project of their parent', () => {
    const rt = makeRuntime(gw);
    const pm = rt.createSession({ templateId: 'project-manager', projectId: 'prj_1' });
    const worker = rt.createSession({ parentId: pm.id });
    expect(worker.info().projectId).toBe('prj_1');
    expect(rt.createSession().info().projectId).toBeUndefined();
  });
});
