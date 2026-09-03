import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFileHonesty, attemptedFileRead } from '../agent/guards.js';
import type { AgentStep } from '../agent/orchestrator.js';

/**
 * A refusal about a file has to be earned.
 *
 * Asked to show the details in a PDF, the assistant answered that the
 * attachment text had not been successfully retrieved, and offered to accept
 * the file if the Director re-sent or uploaded it. The audit trail for that
 * turn records one model call and no tool calls at all. It had not tried, the
 * retrieval it described had never been attempted, and the upload it offered
 * does not exist.
 *
 * Reporting a failure that never happened is the same fault as reporting a
 * success that never happened, and here it is worse: it teaches the Director
 * that a capability she has does not work, and puts the blame on her.
 */

const step = (tool: string, status: AgentStep['status'] = 'success'): AgentStep =>
  ({ tool, summary: tool, status, riskLevel: 0, durationMs: 1, result: {} }) as unknown as AgentStep;

const READ = [step('mail_search'), step('mail_read'), step('mail_list_attachments'), step('mail_read_attachment_text')];
const NOTHING: AgentStep[] = [];
const LOOKED_BUT_DID_NOT_OPEN = [step('mail_search'), step('mail_read')];

describe('Refusing to read a file without opening one', () => {
  const refusals = [
    "I can't show the PDF's details from the information currently available because the attachment text wasn't successfully retrieved.",
    'I cannot read the attachment.',
    'I am unable to access the document contents.',
    "I couldn't open the spreadsheet to see what is in it.",
    'I have no access to the file.',
  ];

  for (const reply of refusals) {
    test(`caught: "${reply.slice(0, 46)}..."`, () => {
      assert.equal(checkFileHonesty(reply, NOTHING).offended, true);
    });
  }

  test('searching and reading the email is not opening the file', () => {
    // The exact shape of the failure: it found the message and stopped.
    assert.equal(checkFileHonesty('I cannot read the attachment.', LOOKED_BUT_DID_NOT_OPEN).offended, true);
  });

  test('the same words are allowed once a read was actually attempted', () => {
    // A genuine failure must still be reportable, or the guard would force it
    // to lie in the opposite direction.
    assert.equal(checkFileHonesty('I cannot read the attachment.', READ).offended, false);
  });

  test('a failed read still counts as an attempt', () => {
    const tried = [step('mail_read_attachment_text', 'failed')];
    assert.equal(attemptedFileRead(tried), true);
    assert.equal(checkFileHonesty('I could not extract the PDF contents.', tried).offended, false);
  });
});

describe('Offering a handover the product cannot accept', () => {
  const offers = [
    'Please re-send the email or upload the PDF, and I will extract its contents.',
    'Please re-send the attachment.',
    'If you can upload the file I will read it.',
  ];

  for (const reply of offers) {
    test(`caught: "${reply.slice(0, 42)}..."`, () => {
      // Wrong even when a read did happen. There is no upload at all.
      assert.equal(checkFileHonesty(reply, READ).offended, true);
    });
  }
});

describe('Ordinary answers pass through untouched', () => {
  const fine = [
    'The contract runs for 24 months with 90 days notice.',
    'Carlo is sending the 2026 Arete Care Contact List for your reference.',
    'The PDF is a scan with no text layer, so there is nothing for me to read in it.',
    'Sarah asked for the revenue figures before Thursday.',
    'There is no attachment on that message.',
  ];

  for (const reply of fine) {
    test(`allowed: "${reply.slice(0, 44)}..."`, () => {
      assert.equal(checkFileHonesty(reply, NOTHING).offended, false, reply);
    });
  }

  test('a real extraction refusal survives, because it is the truth', () => {
    const reply = 'That file is a scan rather than text, and I do not do optical character recognition.';
    assert.equal(checkFileHonesty(reply, READ).offended, false);
  });
});
