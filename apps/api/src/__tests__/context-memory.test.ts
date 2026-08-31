import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, contextBlock, type ContextTurn } from '../agent/context.js';
import { parseExplicitMemory } from '../memory/explicit.js';
import {
  findMemoryConflicts,
  inferMemoryScopeContext,
  ScopedMemoryFallback,
  selectApplicableMemories,
  type MemoryEntry,
} from '../memory/store.js';

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1', type: 'preference', title: 'Email style', content: 'Keep emails short.',
    key: 'style.email.detail', subject: null, importance: 3, confidence: 1,
    source: 'explicit', sourceRef: null, status: 'active', scope: 'global', scopeRef: null,
    conflictState: 'none', supersedesId: null, pinned: false, useCount: 0,
    lastUsedAt: null, lastConfirmedAt: '2026-08-01T00:00:00.000Z', expiresAt: null,
    isExpired: false, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 3 layered conversation context', () => {
  test('retains a relevant older turn without dumping the whole conversation', () => {
    const history: ContextTurn[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: index === 4 ? 'Sarah asked about the Horizon contract renewal wording.' : `Routine unrelated exchange ${index}.`,
    }));
    const assembled = assembleContext({ request: 'Use the same Horizon contract wording for Sarah.', history, maxMessages: 10 });
    assert.ok(assembled.messages.some((turn) => /Horizon contract renewal/.test(turn.content)));
    assert.ok(assembled.messages.length <= 10);
    assert.ok(assembled.messages.length < history.length);
  });

  test('reference language preserves the immediate exchange', () => {
    const history: ContextTurn[] = [
      { role: 'user', content: 'Draft a reply to Sarah.' },
      { role: 'assistant', content: 'Hi Sarah, Thursday works for me.' },
    ];
    const assembled = assembleContext({ request: 'Use the same wording, but move it to tomorrow.', history });
    assert.equal(assembled.messages.length, 2);
    assert.match(assembled.skillQuery, /Thursday works/);
  });

  test('workflow facts distinguish verified work from prepared actions', () => {
    const history: ContextTurn[] = [{
      role: 'assistant', content: 'Review before anything changes.',
      steps: [
        { tool: 'mail_read', summary: 'Read Sarah latest email', status: 'success' },
        { tool: 'mail_reply', summary: 'Prepared reply to Sarah', status: 'approval_required' },
      ],
    }];
    const assembled = assembleContext({ request: 'Change the tone first.', history });
    assert.ok(assembled.recentFacts.some((fact) => fact === 'Verified result: Read Sarah latest email'));
    assert.ok(assembled.recentFacts.some((fact) => fact === 'Prepared, not executed: Prepared reply to Sarah'));
  });

  test('active revision state explicitly says the prior action was not executed', () => {
    const block = contextBlock({
      recentFacts: [],
      activeAction: {
        tool: 'calendar_update', state: 'being_revised',
        preview: { title: 'Move meeting', summary: 'Move Sarah meeting', details: [{ label: 'Time', value: '2 pm' }] },
      },
    });
    assert.match(block, /cancelled and is being revised/);
    assert.match(block, /not executed/);
  });
});

describe('Phase 3 memory scope, precedence and expiry', () => {
  test('infers only relevant domain scopes from the current request', () => {
    assert.deepEqual(inferMemoryScopeContext('Draft an email reply to Sarah.' ).scopes.sort(), ['communication', 'email', 'global', 'operational']);
    assert.ok(inferMemoryScopeContext('Book the project meeting.').scopes.includes('calendar'));
  });

  test('a specific legal communication rule overrides but does not delete the general rule', () => {
    const general = memory({ id: 'general', content: 'Keep emails short.' });
    const legal = memory({ id: 'legal', content: 'Provide detailed emails.', scope: 'communication', scopeRef: 'legal matters' });
    const applicable = selectApplicableMemories([general, legal], {
      scopes: ['global', 'operational', 'communication', 'email'], references: ['legal', 'matters'],
    });
    assert.deepEqual(applicable.map((entry) => entry.id), ['legal']);
    const unrelated = selectApplicableMemories([general, legal], {
      scopes: ['global', 'operational', 'communication', 'email'], references: ['sales'],
    });
    assert.deepEqual(unrelated.map((entry) => entry.id), ['general']);
  });

  test('person-scoped memories cannot contaminate another person', () => {
    const sarah = memory({ id: 'sarah', key: 'person.tone', scope: 'person', scopeRef: 'sarah@example.com', content: 'Use a warm tone with Sarah.' });
    const james = memory({ id: 'james', key: 'person.tone', scope: 'person', scopeRef: 'james@example.com', content: 'Use a formal tone with James.' });
    const applicable = selectApplicableMemories([sarah, james], {
      scopes: ['global', 'operational', 'person'], references: ['sarah@example.com'],
    });
    assert.deepEqual(applicable.map((entry) => entry.id), ['sarah']);
  });

  test('equal-scope opposing memories are detected and withheld', () => {
    const yes = memory({ id: 'yes', key: 'style.short.positive', content: 'Always keep emails short.' });
    const no = memory({ id: 'no', key: 'style.short.negative', content: 'Do not keep emails short.' });
    assert.deepEqual(findMemoryConflicts([yes, no]), [{ firstId: 'yes', secondId: 'no', reason: 'opposing_rules' }]);
    assert.deepEqual(selectApplicableMemories([yes, no], inferMemoryScopeContext('Draft an email.')), []);
  });

  test('expired memories remain representable but never become applicable', () => {
    const expired = memory({ id: 'expired', expiresAt: '2026-01-01T00:00:00.000Z', isExpired: true });
    assert.deepEqual(selectApplicableMemories([expired], inferMemoryScopeContext('Draft an email.')), []);
  });

  test('the fallback store is physically separated by user', () => {
    const fallback = new ScopedMemoryFallback();
    fallback.forUser('director-a').push(memory({ id: 'private-a' }));
    assert.equal(fallback.forUser('director-a').length, 1);
    assert.equal(fallback.forUser('director-b').length, 0);
  });

  test('temporary and matter-specific explicit preferences carry metadata', () => {
    const temporary = parseExplicitMemory("Don't schedule meetings before 9 AM this month.", new Date('2026-08-15T00:00:00.000Z'));
    assert.equal(temporary?.scope, 'calendar');
    assert.equal(temporary?.expiresAt, '2026-09-01T00:00:00.000Z');
    const legal = parseExplicitMemory('For legal matters, provide detailed emails.');
    assert.equal(legal?.scope, 'communication');
    assert.equal(legal?.scopeRef, 'legal matters');
    assert.equal(legal?.key, 'preference.communication.detail');

    const general = parseExplicitMemory('Remember that I prefer short emails.');
    assert.equal(general?.scope, 'email');
    assert.equal(general?.key, legal?.key);
  });
});
