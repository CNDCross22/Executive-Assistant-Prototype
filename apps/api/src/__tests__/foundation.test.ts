import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { env } from '../config/env.js';
import { classifyResponseMode, responsePolicy } from '../agent/response-policy.js';
import {
  budgetCategoryForRole,
  modelForRole,
  modelPolicySummary,
  modelRoleForResponse,
  reasoningEffortForRole,
  serviceTierForRole,
  resolveModelPolicy,
  type ModelRole,
} from '../ai/policy.js';
import { budgetUsdForCategory, costMicros } from '../ai/cost.js';
import { responseGenerationOptions } from '../ai/openai.js';
import { availableTools } from '../agent/registry.js';
import { createOperationContext } from '../observability/context.js';
import { safeTelemetryPayload } from '../observability/telemetry.js';

describe('Phase 1 model policy compatibility', () => {
  test('every role inherits the legacy model unless explicitly configured', () => {
    const configured: Record<ModelRole, string | undefined> = {
      fast: env.OPENAI_FAST_MODEL,
      executive: env.OPENAI_EXECUTIVE_MODEL,
      briefing: env.OPENAI_BRIEFING_MODEL,
      background: env.OPENAI_BACKGROUND_MODEL,
    };
    for (const role of Object.keys(configured) as ModelRole[]) {
      assert.equal(modelForRole(role), configured[role] ?? env.OPENAI_MODEL);
      assert.ok(reasoningEffortForRole(role));
    }
    assert.equal(modelPolicySummary().executive.model, modelForRole('executive'));
    assert.equal(modelPolicySummary().executive.serviceTier, serviceTierForRole('executive'));
  });

  test('response modes map to purpose roles and budget categories deterministically', () => {
    assert.equal(modelRoleForResponse('direct'), 'fast');
    assert.equal(modelRoleForResponse('executive'), 'executive');
    assert.equal(modelRoleForResponse('draft'), 'executive');
    assert.equal(modelRoleForResponse('briefing'), 'briefing');
    assert.equal(budgetCategoryForRole('fast'), 'interactive');
    assert.equal(budgetCategoryForRole('briefing'), 'briefing');
    assert.equal(budgetCategoryForRole('background'), 'background');
    assert.equal(resolveModelPolicy('briefing').role, 'briefing');
  });

  test('role-specific reasoning is passed to GPT-5 requests', () => {
    assert.deepEqual(responseGenerationOptions('gpt-5.6-terra', 900, 0.3, 'medium'), {
      max_output_tokens: 900,
      reasoning: { effort: 'medium' },
    });
  });

  test('current GPT-5.6 rates are known rather than falling through to an unknown rate', () => {
    assert.equal(costMicros('gpt-5.6-luna', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 1_400_000);
    assert.equal(costMicros('gpt-5.6-terra', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 14_000_000);
    assert.equal(costMicros('gpt-5.6-sol', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 24_000_000);
    assert.equal(
      costMicros('gpt-5.6-sol', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'priority'),
      48_000_000,
    );
  });

  test('background model spending is disabled by default', () => {
    assert.equal(budgetUsdForCategory('background'), 0);
  });
});

describe('Phase 1 response policy', () => {
  test('classifies common response shapes without affecting capability or approval', () => {
    assert.equal(classifyResponseMode('How many unread messages do I have?'), 'direct');
    assert.equal(classifyResponseMode('Draft an email to Sarah about Thursday.'), 'draft');
    assert.equal(classifyResponseMode('Prepare a report comparing the options and recommend one.'), 'executive');
    assert.equal(classifyResponseMode('This is a sensitive disciplinary matter.'), 'sensitive');
  });

  test('legacy limits remain the default compatibility policy', () => {
    assert.equal(responsePolicy('direct', false).maxTokens, 800);
    assert.equal(responsePolicy('executive', false).maxTokens, 800);
    assert.equal(responsePolicy('briefing', false).maxTokens, 500);
  });

  test('adaptive limits vary by response mode only when enabled', () => {
    assert.equal(responsePolicy('direct', true).maxTokens, 400);
    assert.equal(responsePolicy('executive', true).maxTokens, 1_800);
    assert.equal(responsePolicy('draft', true).maxTokens, 1_500);
    assert.equal(responsePolicy('briefing', true).maxTokens, 1_000);
  });
});

describe('Phase 1 tool metadata', () => {
  test('all 51 registered tools have coherent operational metadata', () => {
    const tools = availableTools();
    assert.equal(tools.length, 51);
    for (const tool of tools) {
      assert.ok(tool.metadata.category, `${tool.name} category`);
      assert.ok(tool.metadata.effect, `${tool.name} effect`);
      assert.ok(tool.metadata.idempotency, `${tool.name} idempotency`);
      assert.equal(tool.metadata.changesData, tool.riskLevel > 0, `${tool.name} changesData`);
      assert.equal(tool.metadata.confirmation, tool.riskLevel > 0 ? 'explicit' : 'none', `${tool.name} confirmation`);
      assert.equal(tool.metadata.targetFreshness, tool.riskLevel > 0 ? 'preview' : 'none', `${tool.name} freshness`);
    }
  });

  test('externally visible sends are explicitly unsafe to retry', () => {
    for (const name of ['mail_send', 'mail_reply', 'mail_forward', 'mail_send_draft']) {
      const tool = availableTools().find((candidate) => candidate.name === name);
      assert.ok(tool);
      assert.equal(tool.metadata.effect, 'send');
      assert.equal(tool.metadata.idempotency, 'unsafe');
      assert.equal(tool.metadata.confirmation, 'explicit');
    }
  });
});

describe('Phase 1 operation context and telemetry privacy', () => {
  test('creates a distinct workflow id while preserving request ownership', () => {
    const first = createOperationContext({ requestId: 'request-1', userId: 'user-1', conversationId: 'conversation-1', source: 'assistant' });
    const second = createOperationContext({ requestId: 'request-2', userId: 'user-1', source: 'briefing' });
    assert.equal(first.requestId, 'request-1');
    assert.equal(first.conversationId, 'conversation-1');
    assert.notEqual(first.workflowId, second.workflowId);
    assert.match(first.workflowId, /^[0-9a-f-]{36}$/i);
  });

  test('telemetry uses an allowlist and drops content, arguments, and credentials', () => {
    const safe = safeTelemetryPayload({
      category: 'tool',
      action: 'call',
      status: 'success',
      requestId: 'request-1',
      workflowId: 'workflow-1',
      tool: 'mail_read',
      durationMs: 12,
      emailBody: 'private message contents',
      arguments: { messageId: 'secret-id' },
      accessToken: 'secret-token',
    });
    assert.deepEqual(safe, {
      category: 'tool',
      action: 'call',
      status: 'success',
      requestId: 'request-1',
      workflowId: 'workflow-1',
      tool: 'mail_read',
      durationMs: 12,
    });
  });

  test('telemetry rejects unrecognised labels instead of persisting arbitrary text', () => {
    const safe = safeTelemetryPayload({
      category: 'private category',
      action: 'private message contents',
      status: 'unknown state',
      reasonCode: 'contains private prose',
    });
    assert.deepEqual(safe, {
      category: 'security',
      action: 'call',
      status: 'failed',
    });
  });
});
