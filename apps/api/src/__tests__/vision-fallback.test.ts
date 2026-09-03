import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { readFileContents } from '../content/read-file.js';
import { isVisionReadable, imageMediaType, MAX_VISION_PAGES } from '../content/vision.js';

/**
 * Reading a document that has no text in it.
 *
 * A scan and a photographed invoice are ordinary business mail and neither has
 * a text layer, so both were refused. The fallback looks at the page instead.
 *
 * These tests pin the routing and the boundaries around it. They do not make a
 * model call: with no provider configured the vision path fails at the call
 * itself, which is exactly the signal needed here, since reaching that point at
 * all proves the file was routed to vision rather than refused.
 */

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const READER = { userId: 'user-1', requestId: 'req-1' };

/** A PNG header. Enough to be recognised as a picture. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function scannedPdf(pages: number): Uint8Array {
  const ids = Array.from({ length: pages }, (_, index) => 3 + index);
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${ids.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages}>>endobj`,
    ...ids.map((id) => `${id} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj`),
  ];
  return utf8(`%PDF-1.4\n${objects.join('\n')}\ntrailer<</Root 1 0 R/Size ${pages + 3}>>\n%%EOF`);
}

/** Reached the model call, which means it was routed to vision. */
async function routedToVision(input: { bytes: Uint8Array; name: string; contentType?: string }): Promise<boolean> {
  try {
    await readFileContents({ ...input, ...READER });
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    return ['vision_read_failed', 'budget_exhausted', 'no_readable_content'].includes(code);
  }
}

describe('Deciding what only vision can read', () => {
  test('pictures are recognised by extension and by declared type', () => {
    for (const name of ['scan.png', 'invoice.JPG', 'photo.jpeg', 'chart.webp', 'fax.bmp', 'anim.gif']) {
      assert.equal(isVisionReadable(name), true, name);
    }
    assert.equal(isVisionReadable('attachment', 'image/png'), true);
  });

  test('SVG is refused, because it is markup rather than a picture', () => {
    // It can carry script, and a renderer is a far larger attack surface than
    // a bitmap decoder.
    assert.equal(isVisionReadable('logo.svg', 'image/svg+xml'), false);
    assert.equal(imageMediaType('logo.svg', 'image/svg+xml'), null);
  });

  test('a document is not a picture', () => {
    for (const name of ['contract.pdf', 'terms.docx', 'budget.xlsx', 'notes.txt']) {
      assert.equal(isVisionReadable(name), false, name);
    }
  });
});

describe('Extraction always comes first', () => {
  test('a Word file is read from its own characters, not by looking at it', async () => {
    const docx = zipSync({
      'word/document.xml': utf8(
        '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
        '<w:p><w:r><w:t>Service Agreement</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    const read = await readFileContents({ bytes: docx, name: 'agreement.docx', ...READER });

    assert.equal(read.readBy, 'extraction');
    assert.equal(read.text, 'Service Agreement');
    assert.equal(read.readingNote, undefined, 'an extracted file needs no caveat');
  });

  test('plain text never reaches the model', async () => {
    const read = await readFileContents({ bytes: utf8('Just a note.'), name: 'note.txt', ...READER });
    assert.equal(read.readBy, 'extraction');
    assert.equal(read.format, 'text');
  });
});

describe('Falling back to looking at the page', () => {
  test('a picture is routed to vision rather than refused', async () => {
    assert.equal(await routedToVision({ bytes: PNG, name: 'invoice-photo.png' }), true);
  });

  test('a scanned PDF is routed to vision rather than refused', async () => {
    // Before this, the same file raised no_text_layer and stopped there.
    assert.equal(await routedToVision({ bytes: scannedPdf(1), name: 'scanned-contract.pdf' }), true);
  });

  test('a long scan is refused before anything is paid for', async () => {
    await assert.rejects(
      readFileContents({ bytes: scannedPdf(MAX_VISION_PAGES + 3), name: 'long-scan.pdf', ...READER }),
      (err: Error & { code?: string; detail?: string }) => {
        assert.equal(err.code, 'scan_too_long');
        assert.match(err.message, new RegExp(String(MAX_VISION_PAGES + 3)), 'it should say how long the scan is');
        assert.match(err.detail ?? '', /which pages matter/i, 'it should offer a way forward');
        return true;
      },
    );
  });
});

describe('Refusals that vision must not paper over', () => {
  test('the pre-2007 Office formats are still refused with advice', async () => {
    await assert.rejects(
      readFileContents({ bytes: utf8('old binary'), name: 'contract.doc', ...READER }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'unsupported_file_type');
        return true;
      },
    );
  });

  test('a corrupt Office file reports itself rather than going to vision', async () => {
    // unreadable_document is a real failure, not an absence of text, so
    // looking at the page would only produce a confident wrong answer.
    await assert.rejects(
      readFileContents({ bytes: utf8('PK not really a zip'), name: 'broken.docx', ...READER }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'unreadable_document');
        return true;
      },
    );
  });

  test('an oversized file is refused before it is looked at', async () => {
    await assert.rejects(
      readFileContents({ bytes: new Uint8Array(6 * 1024 * 1024), name: 'huge.png', ...READER }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'file_too_large');
        return true;
      },
    );
  });
});
