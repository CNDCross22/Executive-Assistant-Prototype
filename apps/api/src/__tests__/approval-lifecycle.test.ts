import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, executeApprovedTool } from '../agent/registry.js';
import { pendingApproval, parseApprovalDecision, finishApproval, claimApproval } from '../agent/approvals.js';
import { RefTable } from '../agent/refs.js';
import type { ToolContext } from '../agent/tools/types.js';

/**
 * The approval path end to end.
 *
 * This is the code that decides whether a real email leaves the building, and
 * until now it was covered only in pieces: the guards had tests, the store had
 * tests, but nothing walked a mutation from request through preview, approval
 * and execution to receipt. That is the sequence where a mistake sends
 * somebody's mail without asking.
 *
 * Every case below asserts on what actually reached Microsoft, not on what the
 * code reported doing.
 */

let sent: Array<{ to: string[]; subject: string; body: string }> = [];
let conversation = 0;

function context(conversationId: string): ToolContext {
  return {
    user: { id: 'user-1', msUserId: 'ms-1', email: 'director@example.com', displayName: 'Director', jobTitle: null, timezone: 'UTC' },
    me: 'director@example.com',
    refs: new RefTable(),
    conversationId,
    requestId: 'req-1',
    signal: AbortSignal.timeout(5_000),
    mail: {
      async send(input: { to: string[]; subject: string; body: string }) { sent.push(input); },
    },
  } as unknown as ToolContext;
}

// contoso.com rather than example.com: the mail tools deliberately refuse
// placeholder and reserved domains for real actions, which this suite found.
const ARGS = JSON.stringify({ to: ['someone@contoso.com'], subject: 'Quarterly review', body: 'Are you free Thursday?' });

beforeEach(() => { sent = []; conversation += 1; });

describe('A mutation cannot execute without approval', () => {
  test('requesting a send prepares an approval and sends nothing', async () => {
    const ctx = context(`c${conversation}`);
    const outcome = await executeTool('mail_send', ARGS, ctx);

    assert.equal(outcome.status, 'approval_required');
    assert.equal(sent.length, 0, 'mail was sent before anyone approved it');
    assert.ok(outcome.approval, 'no approval record was created');
    assert.match(outcome.approval!.preview.title, /Send this email\?/);
    // The preview must carry what the Director is actually agreeing to.
    const details = outcome.approval!.preview.details.map((d) => `${d.label}: ${d.value}`).join(' | ');
    assert.match(details, /someone@contoso\.com/);
    assert.match(details, /Quarterly review/);
    assert.match(details, /Are you free Thursday\?/);
  });

  test('confirming executes exactly once, with the arguments that were previewed', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);

    const pending = await pendingApproval(ctx.user.id, ctx.conversationId);
    assert.ok(pending);

    const result = await executeApprovedTool(pending, ctx);
    assert.equal(result.status, 'success');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['someone@contoso.com']);
    assert.equal(sent[0]!.subject, 'Quarterly review');
  });

  test('a second confirmation of the same approval cannot send again', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    const first = await executeApprovedTool(pending, ctx);
    const second = await executeApprovedTool(pending, ctx);

    assert.equal(first.status, 'success');
    assert.equal(second.status, 'failed', 'a used approval was accepted a second time');
    assert.equal(sent.length, 1, 'the message was sent twice');
  });

  test('two simultaneous confirmations produce exactly one send', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    // A double-click, or two tabs.
    const [a, b] = await Promise.all([
      executeApprovedTool(pending, ctx),
      executeApprovedTool(pending, ctx),
    ]);

    const succeeded = [a, b].filter((outcome) => outcome.status === 'success');
    assert.equal(succeeded.length, 1, 'both confirmations executed');
    assert.equal(sent.length, 1, 'the message was sent twice');
  });

  test('rejecting leaves nothing sent and nothing pending', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    await finishApproval(pending.id, 'rejected', 'Cancelled by the Director.');

    assert.equal(sent.length, 0);
    assert.equal(await pendingApproval(ctx.user.id, ctx.conversationId), null);
  });

  test('a rejected approval can never be executed afterwards', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    await finishApproval(pending.id, 'rejected');
    const outcome = await executeApprovedTool(pending, ctx);

    assert.equal(outcome.status, 'failed');
    assert.equal(sent.length, 0, 'a cancelled action still sent mail');
  });
});

describe('Only one action may be pending at a time', () => {
  test('a second proposal supersedes the first, and the first cannot run', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const first = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    const secondArgs = JSON.stringify({ to: ['other@contoso.com'], subject: 'Different', body: 'Different message.' });
    await executeTool('mail_send', secondArgs, ctx);

    const current = (await pendingApproval(ctx.user.id, ctx.conversationId))!;
    assert.notEqual(current.id, first.id, 'the old proposal is still the pending one');
    assert.equal(current.preview.summary, 'Different');

    // The superseded proposal must be dead, or a stale "Yes" would send the
    // message the Director has already moved on from.
    const stale = await executeApprovedTool(first, ctx);
    assert.equal(stale.status, 'failed');
    assert.equal(sent.length, 0);
  });

  test('an approval belongs to its own conversation', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    // The same user, a different thread.
    const elsewhere = context(`c${conversation}-other`);
    const outcome = await executeApprovedTool(pending, elsewhere);

    assert.equal(outcome.status, 'failed', 'an approval executed from another conversation');
    assert.equal(sent.length, 0);
  });

  test('another user cannot claim someone else\'s approval', async () => {
    const ctx = context(`c${conversation}`);
    await executeTool('mail_send', ARGS, ctx);
    const pending = (await pendingApproval(ctx.user.id, ctx.conversationId))!;

    assert.equal(await claimApproval(pending.id, 'a-different-user'), null);
    assert.equal(sent.length, 0);
  });
});

describe('Confirmation wording', () => {
  test('only an unambiguous yes approves, and ordinary talk never does', () => {
    for (const yes of ['Yes', 'yes', 'Yes please', 'proceed', 'confirm', 'go ahead']) {
      assert.equal(parseApprovalDecision(yes), 'approve', `"${yes}" should approve`);
    }
    for (const no of ['No', 'cancel', "don't proceed"]) {
      assert.equal(parseApprovalDecision(no), 'reject', `"${no}" should reject`);
    }
    // The dangerous middle: anything that merely contains a yes.
    for (const neither of [
      'yes, but change the subject first',
      'I think yes is what he said',
      'Can you send it?',
      'yes to the meeting, no to the email',
    ]) {
      assert.equal(parseApprovalDecision(neither), null, `"${neither}" must not decide an action`);
    }
  });
});

describe('A read-only tool needs no approval', () => {
  test('reads run immediately and create no approval', async () => {
    const ctx = {
      ...context(`c${conversation}`),
      mail: { async list() { return []; } },
    } as unknown as ToolContext;

    const outcome = await executeTool('mail_recent', JSON.stringify({ limit: 5 }), ctx);
    assert.equal(outcome.status, 'success');
    assert.equal(await pendingApproval(ctx.user.id, ctx.conversationId), null);
  });
});
