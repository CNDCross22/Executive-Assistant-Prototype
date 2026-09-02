import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MailService, textToHtml } from '../graph/mail.service.js';
import type { GraphClient } from '../graph/client.js';

/**
 * A reply body is HTML, and Graph inserts a plain-text `comment` into it
 * verbatim. Every newline became ordinary whitespace, so a greeting, message
 * and sign-off arrived as one run-on line in a real client's mailbox.
 *
 * These tests pin the shape of what leaves the building.
 */

interface Captured { path: string; method: string; body: any }

function fakeGraph(replyContentType = 'html'): { graph: GraphClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const graph = {
    async request(path: string, options: any = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (/createReply|createForward/.test(path)) {
        return {
          id: 'draft-1',
          subject: 'RE: Something',
          body: { contentType: replyContentType, content: '<hr><div id="divRplyFwdMsg">quoted</div>' },
        };
      }
      return {};
    },
  } as unknown as GraphClient;
  return { graph, calls };
}

const BODY = 'Hi Carlo,\n\nIt is good to go.\n\nKind Regards,\nHermes';

describe('Reply and forward formatting', () => {
  test('a reply keeps the paragraphs and the sign-off line break', async () => {
    const { graph, calls } = fakeGraph();
    await new MailService(graph, 'aretecare.com.au').createReplyDraft('m1', BODY);

    const patch = calls.find((call) => call.method === 'PATCH');
    const content: string = patch?.body?.body?.content ?? '';

    assert.match(content, /<p[^>]*>Hi Carlo,<\/p>/, 'the greeting must stand alone');
    assert.match(content, /<p[^>]*>It is good to go\.<\/p>/, 'the message must be its own paragraph');
    assert.match(content, /Kind Regards,<br>Hermes/, 'the name belongs under the sign-off');
    // The regression: everything on one line.
    assert.doesNotMatch(content, /Hi Carlo, It is good to go/, 'line breaks were collapsed');
  });

  test('the quoted conversation survives, below the new text', async () => {
    const { graph, calls } = fakeGraph();
    await new MailService(graph, 'aretecare.com.au').createReplyDraft('m1', BODY);

    const content: string = calls.find((c) => c.method === 'PATCH')?.body?.body?.content ?? '';
    assert.match(content, /divRplyFwdMsg/, 'the quoted thread was discarded');
    assert.ok(content.indexOf('Hi Carlo') < content.indexOf('divRplyFwdMsg'));
  });

  test('a plain-text reply keeps plain text rather than gaining markup', async () => {
    const { graph, calls } = fakeGraph('text');
    await new MailService(graph, 'aretecare.com.au').createReplyDraft('m1', BODY);

    const patch = calls.find((call) => call.method === 'PATCH');
    assert.equal(patch?.body?.body?.contentType, 'Text');
    // <br> tags would be shown literally to the recipient.
    assert.doesNotMatch(String(patch?.body?.body?.content), /<br>|<p>/);
  });

  test('forward is formatted the same way as a reply', async () => {
    const { graph, calls } = fakeGraph();
    await new MailService(graph, 'aretecare.com.au').forward('m1', ['a@b.com'], BODY);

    const content: string = calls.find((c) => c.method === 'PATCH')?.body?.body?.content ?? '';
    assert.match(content, /<p[^>]*>Hi Carlo,<\/p>/);
    assert.match(content, /Kind Regards,<br>Hermes/);
  });

  test('a new draft stays plain text, where newlines already survive', async () => {
    const { graph, calls } = fakeGraph();
    await new MailService(graph, 'aretecare.com.au').createDraft({ to: ['a@b.com'], subject: 'S', body: BODY });

    const create = calls.find((call) => call.path === '/me/messages');
    assert.equal(create?.body?.body?.contentType, 'Text');
    assert.equal(create?.body?.body?.content, BODY, 'the text should be sent through untouched');
  });
});

describe('Plain text to HTML', () => {
  test('blank lines become paragraphs and single newlines become breaks', () => {
    assert.match(textToHtml('One\n\nTwo'), /^<p [^>]*>One<\/p><p [^>]*>Two<\/p>$/);
    assert.match(textToHtml('One\nTwo'), /^<p [^>]*>One<br>Two<\/p>$/);
  });

  test('markup in the text is escaped, never rendered', () => {
    const html = textToHtml('5 < 6 & <script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /5 &lt; 6 &amp;/);
  });

  test('empty and whitespace-only input produce a valid empty body', () => {
    assert.match(textToHtml(''), /^<p style="[^"]+"><\/p>$/);
    assert.match(textToHtml('\n\n  \n'), /^<p style="[^"]+"><\/p>$/);
  });

  test('every paragraph states the font and colour rather than inheriting them', () => {
    // Outlook tints reply text with a theme colour, and an unstyled paragraph
    // takes whatever the recipient's client chooses.
    const html = textToHtml('One\n\nTwo');
    const styled = html.match(/<p style="[^"]*"/g) ?? [];
    assert.equal(styled.length, 2, 'each paragraph needs its own inline style');
    for (const tag of styled) {
      assert.match(tag, /font-family: Aptos, Calibri, sans-serif/);
      assert.match(tag, /font-size: 11pt/);
      assert.match(tag, /color: #000000/);
    }
  });
});
