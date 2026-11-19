// update_plan: the agent's own list of steps for the conversation, shown to the user above the message box with how
// far it is. Each call sends the whole list; the window reads the plan back from the latest call in the conversation.
import { PLAN_TOOL, planProgress, readPlan } from '@spica/protocol';
import type { Tool } from './types.ts';

export const updatePlanTool: Tool = {
  category: 'other',
  // Changes nothing outside the conversation: a round that only planned can still be regenerated.
  readOnly: true,
  spec: {
    name: PLAN_TOOL,
    description:
      'Updates the task plan, which the user sees above the message box with its progress.\n' +
      'Provide an optional explanation and the whole list of plan items, each with a step and status; ' +
      'later calls replace the list (change, add or drop steps as the work goes). An empty list clears the plan.\n' +
      'At most one step can be in_progress at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
        plan: {
          type: 'array',
          description: 'The list of steps.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: 'Task step text, in the language of the conversation.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Step status.' },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    },
  },
  async execute(input) {
    const { steps, error } = readPlan(input.plan);
    if (error) return { content: error, isError: true };
    if (steps.length === 0) return { content: 'Plan cleared.' };
    const { done, total } = planProgress(steps);
    return { content: `Plan updated: ${done} of ${total} steps completed.` };
  },
};
