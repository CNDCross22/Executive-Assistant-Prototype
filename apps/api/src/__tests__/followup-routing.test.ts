import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, type ContextTurn } from '../agent/context.js';
import { selectSkills } from '../agent/skills.js';

/**
 * A follow up has to know what just happened.
 *
 * The assistant read a contact list out of an attachment, described it
 * correctly, and then, asked "can you show me the contacts please?", searched
 * the Outlook address book and reported that it found nothing. The file it had
 * open seconds earlier was never consulted.
 *
 * Nothing was wrong with the reader. The word "contacts" routed the turn to the
 * address book skill, because routing looked only at the words in the newest
 * message. assembleContext had already built a query that weights the current
 * message and then adds the recent turns, and the orchestrator was discarding
 * it in favour of the bare message.
 */

function conversation(): ContextTurn[] {
  return [
    { role: 'user', content: 'What does the message from Carlo Dizon about "Contact List" actually want?' },
    {
      role: 'assistant',
      content: 'Carlo is not asking you to do anything. He is sending the 2026 Arete Care Contact List for your reference.',
      steps: [
        { tool: 'mail_search', summary: 'Searched email', status: 'success' },
        { tool: 'mail_read', summary: 'Opened an email in full', status: 'success' },
        { tool: 'mail_list_attachments', summary: 'Listed email attachments', status: 'success' },
        { tool: 'mail_read_attachment_text', summary: 'Read attachment text', status: 'success' },
      ],
    },
  ];
}

function routeFor(request: string, history: ContextTurn[] = conversation()): string[] {
  const assembled = assembleContext({ request, history });
  return selectSkills(request, 2, false, assembled.recentTools).map((skill) => skill.key);
}

describe('Routing a follow up about a file that was just read', () => {
  test('"can you show me the contacts please?" reaches the attachment skill', () => {
    const keys = routeFor('Can you show me the contacts please?');
    assert.ok(keys.includes('attachments'), `routed to ${keys.join(', ') || 'nothing'}`);
  });

  test('the bare message alone would not have got there', () => {
    // The behaviour being fixed, pinned so it cannot quietly return.
    const withoutContext = selectSkills('Can you show me the contacts please?', 2).map((s) => s.key);
    assert.ok(!withoutContext.includes('attachments'));
    assert.ok(withoutContext.includes('contacts'), `routed to ${withoutContext.join(', ')}`);
  });

  test('other ways of asking the same thing also carry over', () => {
    for (const question of ['Show me the list', 'What names are on it?', 'Can I see them?']) {
      const keys = routeFor(question);
      assert.ok(keys.includes('attachments'), `"${question}" routed to ${keys.join(', ') || 'nothing'}`);
    }
  });

  test('a genuine address book question still reaches contacts', () => {
    // Context must inform routing, not overrule a clear change of subject.
    const keys = routeFor("What is Sarah Chen's phone number in my contacts?");
    assert.ok(keys.includes('contacts'), `routed to ${keys.join(', ')}`);
  });

  test('a new subject still routes to its own skill first', () => {
    // Context informs routing, it does not overrule it. The calendar skill has
    // to be there; whether the attachment skill also rides along in the spare
    // slot is harmless, and dropping a recently used capability would be worse.
    const keys = routeFor('What is in my calendar tomorrow?');
    assert.ok(keys.includes('schedule'), `routed to ${keys.join(', ')}`);
  });

  test('what she asked for is never displaced by what just happened', () => {
    const keys = routeFor('Can you show me the contacts please?');
    assert.ok(keys.includes('contacts'), `the address book skill was pushed out: ${keys.join(', ')}`);
    assert.ok(keys.includes('attachments'), `the file was not carried over: ${keys.join(', ')}`);
  });

  test('with no history nothing is carried', () => {
    const keys = selectSkills('Can you show me the contacts please?', 2, false, []).map((s) => s.key);
    assert.ok(!keys.includes('attachments'));
  });
});

describe('The contacts skill defers to a file that is already open', () => {
  test('it says to answer from the document rather than the address book', () => {
    const skill = selectSkills('contact', 3).find((s) => s.key === 'contacts')!;
    assert.match(skill.instructions, /answer from that\s+file rather than the address book/i);
  });
});

describe('The attachment skill says to re read rather than answer from memory', () => {
  test('because a tool result does not survive into the next turn', () => {
    const skill = selectSkills('read the attachment', 3).find((s) => s.key === 'attachments')!;
    assert.match(skill.instructions, /read it again/i);
    assert.match(skill.instructions, /does not carry over/i);
  });
});
