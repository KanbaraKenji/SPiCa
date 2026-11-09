// Project tools. Top-level agent: create_project, list_projects, open_project.
// Sessions inside a project: project_status, set_stage, add_work_object, list_work_objects.
import type { Runtime } from '../runtime.ts';
import type { ProjectDetail, WorkObject } from '../types.ts';
import type { Tool, ToolContext } from './types.ts';

function rt(ctx: ToolContext): Runtime {
  const r = ctx.services.runtime as Runtime | undefined;
  if (!r) throw new Error('project tools need the runtime service');
  return r;
}

function projectOf(ctx: ToolContext): string {
  const id = rt(ctx).session(ctx.sessionId)?.info().projectId;
  if (!id) throw new Error('this session does not belong to a project');
  return id;
}

const topOnly = (env: { role?: string }) => env.role === 'top';
const inProject = (env: { projectId?: string }) => !!env.projectId;

function objectTree(objects: WorkObject[]): string {
  if (objects.length === 0) return '(no work objects yet)';
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const o of objects.filter((x) => x.parentId === parent)) {
      lines.push(`${'  '.repeat(depth)}- [${o.level}] ${o.name} (${o.id})`);
      walk(o.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

function describe(d: ProjectDetail): string {
  const stage = d.workflow?.stages.find((s) => s.id === d.stage);
  const lines = [
    `# ${d.name} (${d.id})`,
    `Folder: ${d.folder}`,
    `Project manager: ${d.manager.id}, status ${d.manager.status}`,
    d.workflow
      ? `Workflow: ${d.workflow.name}; stages: ${d.workflow.stages.map((s) => (s.id === d.stage ? `[${s.name}]` : s.name)).join(' → ')}`
      : 'Workflow: none',
  ];
  if (stage?.goal) lines.push(`Current stage goal: ${stage.goal}`);
  if (stage?.exitCriteria?.length) lines.push(`Exit criteria: ${stage.exitCriteria.join('; ')}`);
  lines.push('', 'Work objects:', objectTree(d.objects));
  if (d.agents.length > 0) {
    lines.push('', 'Sub-agents:', ...d.agents.map((a) => `- ${a.title ?? 'Sub-agent'} (${a.id}): ${a.status}`));
  }
  if (d.recentLog.length > 0) {
    lines.push('', 'Recent key actions (newest first):', ...d.recentLog.slice(0, 10).map((e) => `- ${e.at} ${e.action}: ${e.summary}`));
  }
  return lines.join('\n');
}

export const createProjectTool: Tool = {
  spec: {
    name: 'create_project',
    description:
      'Create a project: a folder plus a persistent project manager agent that handles everything in it. ' +
      'Give a short name, optionally a folder (absolute, or relative to the projects folder), a workflow id, and a brief ' +
      'that becomes the project manager\'s first task.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        folder: { type: 'string' },
        workflow: { type: 'string', description: 'Workflow id (see list_projects for the available workflows).' },
        brief: { type: 'string' },
      },
      required: ['name'],
    },
  },
  available: topOnly,
  async execute(input, ctx) {
    const r = rt(ctx);
    const p = r.createProject({
      name: String(input.name),
      ...(typeof input.folder === 'string' ? { folder: input.folder } : {}),
      ...(typeof input.workflow === 'string' ? { workflowId: input.workflow } : {}),
      ...(typeof input.brief === 'string' ? { brief: input.brief } : {}),
    });
    return {
      content:
        `Created project "${p.name}" (${p.id}) in ${p.folder}. Its project manager is ${p.managerSessionId}` +
        `${input.brief ? ' and is working on the brief' : ''}. Talk to it with message_agent.`,
    };
  },
};

export const listProjectsTool: Tool = {
  spec: {
    name: 'list_projects',
    description: 'List all projects with folder, stage, project manager status and the latest key action; also lists available workflows.',
    inputSchema: { type: 'object', properties: {} },
  },
  available: topOnly,
  async execute(_input, ctx) {
    const r = rt(ctx);
    const rows = r.listProjects().map((p) => {
      const d = r.getProject(p.id);
      const last = d?.recentLog[0];
      return `- ${p.name} (${p.id}) — folder ${p.folder}; stage ${p.stage ?? 'none'}; manager ${d?.manager.status ?? 'missing'}${last ? `; last: ${last.summary}` : ''}`;
    });
    const wfs = [...r.workflows.values()].map((w) => `${w.id} (${w.name})`).join(', ') || 'none';
    return { content: `${rows.length ? rows.join('\n') : 'No projects yet.'}\nAvailable workflows: ${wfs}` };
  },
};

export const openProjectTool: Tool = {
  spec: {
    name: 'open_project',
    description: 'Show where a project stands: stage, work objects, sub-agents and recent key actions. Accepts the project id or name.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  },
  available: topOnly,
  async execute(input, ctx) {
    const r = rt(ctx);
    const key = String(input.project);
    const p = r.listProjects().find((x) => x.id === key || x.name === key);
    const d = p && r.getProject(p.id);
    if (!d) return { content: `No project "${key}".`, isError: true };
    return { content: describe(d) };
  },
};

export const projectStatusTool: Tool = {
  spec: {
    name: 'project_status',
    description: 'Your project: workflow, current stage with goal and exit criteria, work objects, sub-agents, recent key actions.',
    inputSchema: { type: 'object', properties: {} },
  },
  available: inProject,
  async execute(_input, ctx) {
    const d = rt(ctx).getProject(projectOf(ctx));
    return d ? { content: describe(d) } : { content: 'Project not found.', isError: true };
  },
};

export const setStageTool: Tool = {
  spec: {
    name: 'set_stage',
    description: 'Move your project to another stage of its workflow (id or name), with a short note on why. The top-level agent is told.',
    inputSchema: { type: 'object', properties: { stage: { type: 'string' }, note: { type: 'string' } }, required: ['stage'] },
  },
  available: inProject,
  async execute(input, ctx) {
    const p = rt(ctx).setStage(projectOf(ctx), String(input.stage), typeof input.note === 'string' ? input.note : undefined, ctx.sessionId);
    return { content: `Stage is now "${p.stage}".` };
  },
};

export const addWorkObjectTool: Tool = {
  spec: {
    name: 'add_work_object',
    description: 'Add a work object (e.g. a product, a part) to your project. The level must be one of the workflow\'s levels; give parent_id when the level has a parent level.',
    inputSchema: {
      type: 'object',
      properties: { level: { type: 'string' }, name: { type: 'string' }, parent_id: { type: 'string' } },
      required: ['level', 'name'],
    },
  },
  available: inProject,
  async execute(input, ctx) {
    const o = rt(ctx).addWorkObject(projectOf(ctx), {
      level: String(input.level),
      name: String(input.name),
      ...(typeof input.parent_id === 'string' ? { parentId: input.parent_id } : {}),
    });
    return { content: `Added [${o.level}] ${o.name} (${o.id}).` };
  },
};

export const listWorkObjectsTool: Tool = {
  spec: {
    name: 'list_work_objects',
    description: 'List the work objects of your project as a tree.',
    inputSchema: { type: 'object', properties: {} },
  },
  available: inProject,
  async execute(_input, ctx) {
    const d = rt(ctx).getProject(projectOf(ctx));
    return { content: d ? objectTree(d.objects) : 'Project not found.' };
  },
};

export const projectTools: Tool[] = [
  createProjectTool,
  listProjectsTool,
  openProjectTool,
  projectStatusTool,
  setStageTool,
  addWorkObjectTool,
  listWorkObjectsTool,
];
