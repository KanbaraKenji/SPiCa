import { describe, expect, it } from 'vitest';
import { planProgress, readPlan } from '@spica/protocol';
import { updatePlanTool } from './plan-tool.ts';
import type { ToolContext } from './types.ts';

const ctx = {} as ToolContext;
const run = (plan: unknown) => updatePlanTool.execute({ plan }, ctx);

describe('update_plan', () => {
  it('takes the whole list and says how far it is', async () => {
    const out = await run([
      { step: '读资料', status: 'completed' },
      { step: '写纪要', status: 'in_progress' },
      { step: '发草稿', status: 'pending' },
    ]);
    expect(out).toEqual({ content: 'Plan updated: 1 of 3 steps completed.' });
  });

  it('refuses two steps in progress, an unknown status, a list that is not one', async () => {
    expect((await run([{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }])).isError).toBe(true);
    expect((await run([{ step: 'a', status: 'done' }])).content).toContain('Unknown status');
    expect((await run('a, b')).isError).toBe(true);
  });

  it('an empty list clears the plan', async () => {
    expect(await run([])).toEqual({ content: 'Plan cleared.' });
  });

  it('is read-only (a round that only planned can be regenerated)', () => {
    expect(updatePlanTool.readOnly).toBe(true);
  });
});

describe('readPlan / planProgress', () => {
  it('trims steps and drops empty ones', () => {
    expect(readPlan([{ step: '  读资料 ', status: 'pending' }, { step: ' ', status: 'pending' }]).steps).toEqual([{ step: '读资料', status: 'pending' }]);
  });

  it('the current step: the one in progress, else the first not done', () => {
    expect(planProgress([{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }])).toMatchObject({ done: 1, total: 3, currentIndex: 1 });
    expect(planProgress([{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }])).toMatchObject({ done: 1, currentIndex: 1 });
    expect(planProgress([{ step: 'a', status: 'completed' }])).toMatchObject({ done: 1, total: 1, currentIndex: -1 });
  });
});

describe('update_plan for sub-agents', () => {
  it('a sub-agent started with spawn_agent is sent the same update_plan as its parent', async () => {
    const { makeRuntime, startGateway } = await import('../testing/helpers.ts');
    const gw = await startGateway();
    try {
      const rt = makeRuntime(gw, { defaults: { providerId: 'fake-openai', model: 'fake-model', maxTokens: 512 } });
      const top = rt.createSession();
      const seen: { child: boolean; tool: unknown }[] = [];
      gw.onRequest((req) => {
        const body = JSON.stringify(req.body);
        const tools = (req.body.tools ?? []) as { function?: { name?: string } }[];
        const child = body.includes('write the list');
        seen.push({ child, tool: tools.find((t) => t.function?.name === 'update_plan') });
        if (!child && !body.includes('Started sub-agent')) return { toolCalls: [{ name: 'spawn_agent', args: { title: 'helper', task: 'write the list' } }] };
        return { text: 'ok' };
      });
      await top.send('start a helper').done;
      const kid = rt.sessions().find((s) => s.parentId === top.id);
      expect(kid).toBeDefined();
      await kid?.idle();
      const parentTool = seen.find((s) => !s.child)?.tool;
      const childTool = seen.find((s) => s.child)?.tool;
      expect(parentTool).toBeDefined();
      expect(childTool).toEqual(parentTool);
      await rt.close();
    } finally {
      await gw.stop();
    }
  });
});
