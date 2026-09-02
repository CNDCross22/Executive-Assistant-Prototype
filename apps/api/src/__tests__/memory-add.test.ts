import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { remember, titleFor, listMemory } from '../memory/store.js';

/**
 * Writing a preference by hand.
 *
 * The assistant could already save a rule when asked, and it could propose one
 * it had noticed, but the page listing every rule had no way to write one: the
 * Director could review and delete what was there and nothing else. Stating a
 * rule outright is the most direct thing she can do and it was the one route
 * missing.
 *
 * These run against the in-memory store, which is what the API uses before a
 * database exists, so they exercise the same code path the route does.
 */

describe('A rule saved without a label gets a sensible one', () => {
  test('a short rule becomes its own title', () => {
    assert.equal(titleFor('Never book me before 9am.'), 'Never book me before 9am');
  });

  test('only the first sentence is used', () => {
    assert.equal(
      titleFor('Always show me a draft before sending. I want to read every word that goes out.'),
      'Always show me a draft before sending',
    );
  });

  test('a long sentence is cut at a word, never mid-word', () => {
    const long = 'Invoices from any supplier we have not worked with before must be checked against the purchase order and approved by finance before payment';
    const title = titleFor(long);

    assert.ok(title.length <= 81, `title was ${title.length} characters`);
    assert.ok(title.endsWith('…'), 'a truncated title should say so');
    // The cut must land on a word boundary: the last word is whole or gone.
    const words = title.replace('…', '').trim().split(' ');
    assert.ok(long.startsWith(words.join(' ')), 'the title should be a whole-word prefix of the rule');
  });

  test('surrounding whitespace and runs of spaces are tidied', () => {
    assert.equal(titleFor('   Keep   my replies    short.  '), 'Keep my replies short');
  });

  test('a rule with no sentence break still produces a title', () => {
    assert.equal(titleFor('James is the CFO'), 'James is the CFO');
  });
});

describe('Adding a preference by hand', () => {
  test('it is active at once, because she stated it rather than it being inferred', async () => {
    const userId = `add-${Date.now()}-1`;
    const content = 'Never book me before 9am.';

    const entry = await remember({
      userId,
      type: 'preference',
      title: titleFor(content),
      content,
      source: 'explicit',
      confidence: 1,
      status: 'active',
    });

    assert.ok(entry);
    assert.equal(entry!.status, 'active', 'a stated rule should not wait for approval');
    assert.equal(entry!.source, 'explicit');
    assert.equal(entry!.content, content);
    assert.equal(entry!.title, 'Never book me before 9am');
    // Stating it counts as confirming it.
    assert.ok(entry!.lastConfirmedAt, 'a stated rule should record when it was confirmed');

    const saved = await listMemory(userId);
    assert.equal(saved.filter((e) => e.status === 'active').length, 1);
  });

  test('a fact about a person is scoped to that person', async () => {
    const userId = `add-${Date.now()}-2`;
    const entry = await remember({
      userId,
      type: 'person',
      title: titleFor('James is the CFO and approves spend over $5k.'),
      content: 'James is the CFO and approves spend over $5k.',
      subject: 'James@Company.com',
      source: 'explicit',
      confidence: 1,
      status: 'active',
    });

    assert.ok(entry);
    assert.equal(entry!.scope, 'person', 'a person fact should not apply globally');
    // Addresses are compared case-insensitively everywhere else; here too.
    assert.equal(entry!.subject, 'james@company.com');
    assert.equal(entry!.scopeRef, 'james@company.com');
  });

  test('a rule for the assistant is scoped to its own behaviour', async () => {
    const userId = `add-${Date.now()}-3`;
    const entry = await remember({
      userId,
      type: 'operational',
      title: 'Show a draft first',
      content: 'Always show me a draft before sending.',
      source: 'explicit',
      confidence: 1,
      status: 'active',
    });

    assert.ok(entry);
    assert.equal(entry!.scope, 'operational');
  });

  test('saving the same rule twice does not produce two of it', async () => {
    const userId = `add-${Date.now()}-4`;
    const content = 'Keep my replies short.';
    const args = {
      userId, type: 'preference' as const, title: titleFor(content), content,
      source: 'explicit' as const, confidence: 1, status: 'active' as const,
    };

    await remember(args);
    await remember(args);

    const active = (await listMemory(userId)).filter((e) => e.status === 'active');
    assert.equal(active.length, 1, 'a repeated rule should be recognised, not duplicated');
  });

  test('one Director never sees another Director\'s rules', async () => {
    const first = `add-${Date.now()}-5a`;
    const second = `add-${Date.now()}-5b`;

    await remember({
      userId: first, type: 'preference', title: 'Private', content: 'Only mine.',
      source: 'explicit', confidence: 1, status: 'active',
    });

    assert.equal((await listMemory(second)).length, 0);
  });
});
