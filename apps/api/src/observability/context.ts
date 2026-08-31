import { randomUUID } from 'node:crypto';

export interface OperationContext {
  requestId: string;
  workflowId: string;
  userId: string;
  conversationId?: string;
  source: 'assistant' | 'briefing' | 'background';
}

export function createOperationContext(input: Omit<OperationContext, 'workflowId'> & { workflowId?: string }): OperationContext {
  return { ...input, workflowId: input.workflowId ?? randomUUID() };
}
