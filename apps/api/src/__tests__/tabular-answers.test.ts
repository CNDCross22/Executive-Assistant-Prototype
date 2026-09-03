import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSkills } from '../agent/skills.js';
import { sanitiseReply } from '../agent/sanitise.js';
import { personaBlock } from '../agent/persona.js';

/**
 * Answering with a directory, and being asked for one.
 *
 * A three page staff contact list was read correctly and then presented as a
 * single run of pipes, unusable. Asked to send the names and numbers, the
 * assistant searched the address book instead and reported that it could not
 * find the attachment.
 *
 * Two separate faults. "Send me" was read as a request to send mail, which
 * routed the turn to the action skills and cut off every read skill. And a
 * markdown table had nothing to render it, so every row fell through to the
 * paragraph branch and was joined into one line.
 */

const AFTER_READING_AN_ATTACHMENT = [
  'mail_search', 'mail_read', 'mail_list_attachments', 'mail_read_attachment_text',
];

function route(request: string): string[] {
  return selectSkills(request, 2, true, AFTER_READING_AN_ATTACHMENT).map((skill) => skill.key);
}

describe('"Send me" is a request to be shown, not a request to send', () => {
  const askingToBeShown = [
    'Send me the names and phone number please.',
    'Send me the list',
    'Give me those numbers',
    'Show me them',
    'Forward me the details',
  ];

  for (const request of askingToBeShown) {
    test(`"${request}" keeps the file in reach`, () => {
      const keys = route(request);
      assert.ok(keys.includes('attachments'), `routed to ${keys.join(', ')}`);
    });
  }

  test('a real send is still a send', () => {
    // An explicit address is the tell. This must stay an action, or the guard
    // rails around sending mail would be routed away from.
    for (const request of ['Send the report to james@contoso.com', 'Forward it to sarah@contoso.com']) {
      const keys = route(request);
      assert.ok(keys.includes('email_actions'), `"${request}" routed to ${keys.join(', ')}`);
      assert.ok(!keys.includes('attachments'), `"${request}" should not inherit a read skill`);
    }
  });
});

describe('A table survives the last gate before the Director sees it', () => {
  const table = [
    'Australia',
    '',
    '| Name | Phone |',
    '| --- | --- |',
    '| Pinki Tokas | (03) 8353 1837 |',
    '| Daniel Etherden | 0427 471 824 |',
  ].join('\n');

  test('the rows and the rule are left intact', () => {
    const cleaned = sanitiseReply(table);
    assert.match(cleaned, /\| Name \| Phone \|/);
    assert.match(cleaned, /\| --- \| --- \|/, 'the rule is what tells the renderer it is a table');
    assert.match(cleaned, /\| Pinki Tokas \| \(03\) 8353 1837 \|/);
  });

  test('each row is still its own line', () => {
    // Joining them is precisely what made the directory unreadable.
    const lines = sanitiseReply(table).split('\n').filter((line) => line.startsWith('|'));
    assert.equal(lines.length, 4, `expected four table lines, saw ${lines.length}`);
  });

  test('a bullet list is still converted, so the two do not collide', () => {
    const cleaned = sanitiseReply('- First\n- Second');
    assert.match(cleaned, /• First/);
  });
});

describe('The assistant is told to lay a directory out as a table', () => {
  test('the instruction names the rule row, which is what makes it render', () => {
    const persona = personaBlock();
    assert.match(persona, /markdown table/i);
    assert.match(persona, /\|---\|/);
    assert.match(persona, /cannot be used/i);
  });
});
