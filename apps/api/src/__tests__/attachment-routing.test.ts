import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSkills } from '../agent/skills.js';
import { executeTool } from '../agent/registry.js';
import { RefTable } from '../agent/refs.js';
import type { ToolContext } from '../agent/tools/types.js';
import type { MailMessage } from '../graph/mail.service.js';

/**
 * Getting from "can you see what is in the file" to actually opening it.
 *
 * The reader for PDF and Office shipped and the assistant still said it could
 * not see inside an attachment. Three things were wrong at once and none of
 * them was the reader.
 *
 * The skill that governs attachments still carried the instruction written
 * before the reader existed, telling the model never to imply that a PDF or an
 * Office document had been inspected. Its triggers listed "read the file" and
 * "open the file" but not the way a person actually asks. And a search result
 * said nothing about an attachment at all, so after searching there was no
 * signal that a file was even there.
 */

describe('The way the Director actually asks reaches the attachment skill', () => {
  const asked = [
    'Can you see what is in the file?',
    "What's in the file Carlo sent?",
    'Open the file and tell me what it says',
    'Read the attachment',
    'What is attached to that message?',
    'Can you check the document he sent?',
    'What does the PDF say?',
    'Have a look at the spreadsheet',
    'What are the contents of that file?',
  ];

  for (const question of asked) {
    test(`"${question}" selects the attachment skill`, () => {
      const keys = selectSkills(question, 3).map((skill) => skill.key);
      assert.ok(keys.includes('attachments'), `selected ${keys.join(', ') || 'nothing'}`);
    });
  }

  test('an unrelated question does not drag it in', () => {
    const keys = selectSkills('What needs me today?', 3).map((skill) => skill.key);
    assert.ok(!keys.includes('attachments'), `selected ${keys.join(', ')}`);
  });
});

describe('The attachment skill no longer says PDF and Office are unreadable', () => {
  const skill = selectSkills('read the attachment', 3).find((s) => s.key === 'attachments')!;

  test('it exists and names the formats it can open', () => {
    assert.ok(skill, 'the attachments skill was not selected');
    for (const format of ['PDF', 'Word', 'Excel', 'PowerPoint']) {
      assert.match(skill.instructions, new RegExp(format), `${format} is not named`);
    }
  });

  test('the instruction that caused the refusal is gone', () => {
    assert.doesNotMatch(
      skill.instructions,
      /unsupported PDF|Office document was inspected/i,
      'the stale instruction is still telling the model these formats are unsupported',
    );
  });

  test('it still holds the two refusals that are real', () => {
    assert.match(skill.instructions, /scan/i, 'a scanned PDF must still be reported as a scan');
    assert.match(skill.instructions, /\.doc, \.xls and \.ppt/, 'the pre-2007 formats must still be refused');
  });

  test('it still treats a file as untrusted', () => {
    assert.match(skill.instructions, /untrusted external content/i);
    assert.match(skill.instructions, /malware/i);
  });
});

// --- what a search hands back ----------------------------------------------

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1', conversationId: 'c1', subject: 'Contact List',
    from: { name: 'Carlo Dizon', address: 'carlo@contoso.com' },
    toRecipients: [{ name: 'Director', address: 'director@contoso.com' }],
    ccRecipients: [], bccRecipients: [],
    receivedAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    isRead: false, hasAttachments: true, importance: 'normal',
    bodyPreview: 'Sending the contact list for your reference.', webLink: '', isExternal: true,
    ...overrides,
  };
}

function context(mail: Partial<Record<string, unknown>>): ToolContext {
  return {
    user: { id: 'user-1', msUserId: 'ms-1', email: 'director@contoso.com', displayName: 'Director', jobTitle: null, timezone: 'UTC' },
    me: 'director@contoso.com',
    refs: new RefTable(),
    conversationId: `att-${Date.now()}-${Math.random()}`,
    requestId: 'req-1',
    signal: AbortSignal.timeout(5_000),
    mail,
  } as unknown as ToolContext;
}

describe('A search says whether there is a file to open', () => {
  test('a result carries hasAttachment', async () => {
    const ctx = context({ async search() { return [message()]; } });
    const outcome = await executeTool('mail_search', JSON.stringify({ query: 'Carlo Dizon Contact List' }), ctx);

    assert.equal(outcome.status, 'success');
    const result = outcome.result as { results: { hasAttachment: boolean }[]; note: string };
    assert.equal(result.results[0]!.hasAttachment, true, 'the search result hid the attachment');
    assert.match(result.note, /list its attachments/i, 'nothing told the model what to do about it');
  });

  test('a message with no attachment is marked as such', async () => {
    const ctx = context({ async search() { return [message({ hasAttachments: false })]; } });
    const outcome = await executeTool('mail_search', JSON.stringify({ query: 'anything' }), ctx);
    const result = outcome.result as { results: { hasAttachment: boolean }[] };
    assert.equal(result.results[0]!.hasAttachment, false);
  });
});

describe('Reading a message points at the file rather than stopping at it', () => {
  test('the status names the next step instead of reporting a dead end', async () => {
    const ctx = context({
      // `find` resolves through a search before it opens anything.
      async search() { return [message()]; },
      async get() { return { ...message(), body: 'Sending the contact list for your reference.' }; },
      async thread() { return []; },
    });
    const outcome = await executeTool('mail_read', JSON.stringify({ find: 'Contact List' }), ctx);

    const result = outcome.result as { attachmentStatus: string };
    assert.match(result.attachmentStatus, /has an attachment/i);
    assert.match(result.attachmentStatus, /list the attachments and read/i);
    // The old wording stated a fact and offered nowhere to go, and the model
    // duly reported it and stopped.
    assert.doesNotMatch(result.attachmentStatus, /present but has not been inspected/i);
  });
});
