import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { extractDocumentText, documentFormat, supportsExtraction } from '../content/documents.js';

/**
 * Reading PDF and Office attachments.
 *
 * Every fixture below is a real file: a real ZIP container with real OOXML
 * inside it, and a real PDF parsed by the real parser. Nothing here is a
 * stubbed extractor agreeing with itself — the point of the exercise is
 * whether an actual contract, invoice or spreadsheet comes back readable.
 */

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

// --- fixtures --------------------------------------------------------------

function pdfOf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);

  objects.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj');
  objects.push(`2 0 obj<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>endobj`);

  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    objects.push(
      `${pageId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R` +
      `/Resources<</Font<</F1 99 0 R>>>>>>endobj`,
    );
    const drawn = lines.map((line, at) => `${at === 0 ? '72 700 Td' : '0 -20 Td'} (${line}) Tj`).join(' ');
    const stream = `BT /F1 12 Tf ${drawn} ET`;
    objects.push(`${contentId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`);
  });

  objects.push('99 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj');
  return utf8(`%PDF-1.4\n${objects.join('\n')}\ntrailer<</Root 1 0 R/Size 100>>\n%%EOF`);
}

/** A page that exists but carries no content stream: what a scan looks like. */
const SCANNED_PDF = utf8(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
  'trailer<</Root 1 0 R/Size 4>>\n%%EOF',
);

function docxOf(body: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': utf8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': utf8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  });
}

function xlsxOf(sharedStrings: string[], sheets: Record<string, string>, names: string[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': utf8(
      `<?xml version="1.0"?><workbook><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
    'xl/sharedStrings.xml': utf8(
      `<?xml version="1.0"?><sst>${sharedStrings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`,
    ),
  };
  for (const [entry, rows] of Object.entries(sheets)) {
    files[entry] = utf8(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`);
  }
  return zipSync(files);
}

function pptxOf(slides: string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  slides.forEach((lines, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = utf8(
      `<?xml version="1.0"?><p:sld xmlns:a="a"><p:cSld>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

// --- format detection ------------------------------------------------------

describe('Deciding what a file is', () => {
  test('by extension and by declared type', () => {
    assert.equal(documentFormat('contract.pdf'), 'pdf');
    assert.equal(documentFormat('Statement Of Work.DOCX'), 'docx');
    assert.equal(documentFormat('budget.xlsx'), 'xlsx');
    assert.equal(documentFormat('deck.pptx'), 'pptx');
    // Outlook is not always honest about the name; the declared type also counts.
    assert.equal(documentFormat('attachment', 'application/pdf'), 'pdf');
    assert.equal(documentFormat('notes.txt'), null);
  });

  test('supportsExtraction covers plain text and documents alike', () => {
    for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.txt', 'a.csv', 'a.md']) {
      assert.equal(supportsExtraction(name), true, `${name} should be readable`);
    }
    for (const name of ['a.exe', 'a.zip', 'a.png', 'a.doc', 'a.xls']) {
      assert.equal(supportsExtraction(name), false, `${name} should not be readable`);
    }
  });
});

// --- PDF -------------------------------------------------------------------

describe('PDF', () => {
  test('reads the text of every page and reports how many there were', async () => {
    const result = await extractDocumentText({
      bytes: pdfOf([
        ['Invoice 4417', 'Total 12,480.00 AUD'],
        ['Payment due 30 September 2026'],
      ]),
      name: 'invoice.pdf',
    });

    assert.equal(result.format, 'pdf');
    assert.equal(result.pages, 2);
    assert.match(result.text, /Invoice 4417/);
    assert.match(result.text, /Total 12,480\.00 AUD/);
    assert.match(result.text, /Payment due 30 September 2026/);
  });

  test('a scan with no text layer says so rather than returning nothing', async () => {
    // This is the case that matters most: an empty string handed to a model is
    // an invitation to invent the contents of a document nobody has read.
    await assert.rejects(
      extractDocumentText({ bytes: SCANNED_PDF, name: 'scanned-contract.pdf' }),
      (err: Error & { code?: string; detail?: string }) => {
        assert.equal(err.code, 'no_text_layer');
        assert.match(err.message, /scanned-contract\.pdf/);
        assert.match(err.detail ?? '', /optical character recognition/i);
        return true;
      },
    );
  });

  test('a file that is not a PDF at all is refused, not guessed at', async () => {
    await assert.rejects(
      extractDocumentText({ bytes: utf8('this is not a PDF'), name: 'broken.pdf' }),
      (err: Error & { code?: string }) => {
        assert.match(err.code ?? '', /unreadable_document|no_text_layer/);
        return true;
      },
    );
  });
});

// --- Word ------------------------------------------------------------------

describe('Word', () => {
  test('paragraphs, runs, breaks and tabs come back as written', async () => {
    const result = await extractDocumentText({
      bytes: docxOf(
        '<w:p><w:r><w:t>Service Agreement</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Term: </w:t></w:r><w:r><w:t>24 months</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Notice</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>90 days</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Fee</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>4,200</w:t></w:r></w:p>',
      ),
      name: 'agreement.docx',
    });

    assert.equal(result.format, 'docx');
    const lines = result.text.split('\n');
    assert.equal(lines[0], 'Service Agreement');
    // Two runs in one paragraph are one sentence, not two lines.
    assert.equal(lines[1], 'Term: 24 months');
    assert.equal(lines[2], 'Notice');
    assert.equal(lines[3], '90 days');
    assert.equal(lines[4], 'Fee\t4,200');
  });

  test('a table keeps its rows and columns', async () => {
    const result = await extractDocumentText({
      bytes: docxOf(
        '<w:tbl>' +
        '<w:tr><w:tc><w:p><w:r><w:t>Milestone</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Date</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>Handover</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>14 October</w:t></w:r></w:p></w:tc></w:tr>' +
        '</w:tbl>',
      ),
      name: 'plan.docx',
    });

    const lines = result.text.split('\n');
    assert.equal(lines[0], 'Milestone\tDate');
    assert.equal(lines[1], 'Handover\t14 October');
  });

  test('XML entities are decoded once, not twice', async () => {
    const result = await extractDocumentText({
      bytes: docxOf('<w:p><w:r><w:t>Ben &amp; Co. charge &lt; 5% &#8212; see &quot;Schedule 2&quot;</w:t></w:r></w:p>'),
      name: 'terms.docx',
    });
    assert.equal(result.text, 'Ben & Co. charge < 5% — see "Schedule 2"');
  });

  test('a corrupt archive is reported, not silently empty', async () => {
    await assert.rejects(
      extractDocumentText({ bytes: utf8('PK not really a zip'), name: 'broken.docx' }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'unreadable_document');
        return true;
      },
    );
  });
});

// --- Excel -----------------------------------------------------------------

describe('Excel', () => {
  test('shared strings, inline strings and numbers all resolve', async () => {
    const result = await extractDocumentText({
      bytes: xlsxOf(
        ['Client', 'Amount', 'Arete Care'],
        {
          'xl/worksheets/sheet1.xml':
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12480</v></c></row>' +
            '<row r="3"><c r="A3" t="inlineStr"><is><t>Direct entry</t></is></c><c r="B3"><v>900</v></c></row>',
        },
        ['Invoices'],
      ),
      name: 'billing.xlsx',
    });

    assert.equal(result.format, 'xlsx');
    const lines = result.text.split('\n');
    assert.equal(lines[0], 'Sheet: Invoices');
    assert.equal(lines[1], 'Client\tAmount');
    assert.equal(lines[2], 'Arete Care\t12480');
    assert.equal(lines[3], 'Direct entry\t900');
  });

  test('an empty column stays empty so values keep their headings', async () => {
    // A gap silently closed puts every figure under the wrong column, which is
    // worse than not reading the sheet at all.
    const result = await extractDocumentText({
      bytes: xlsxOf(
        ['Name', 'Region', 'Total'],
        {
          'xl/worksheets/sheet1.xml':
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>Northside</t></is></c><c r="C2"><v>3100</v></c></row>',
        },
        ['Summary'],
      ),
      name: 'regions.xlsx',
    });

    const lines = result.text.split('\n');
    assert.equal(lines[1], 'Name\tRegion\tTotal');
    // Northside has no region; 3100 must stay under Total.
    assert.equal(lines[2]!.split('\t').length, 3);
    assert.equal(lines[2]!.split('\t')[2], '3100');
  });

  test('rows that carry only formatting are dropped', async () => {
    const result = await extractDocumentText({
      bytes: xlsxOf(
        ['Item'],
        {
          'xl/worksheets/sheet1.xml':
            '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
            '<row r="2"><c r="A2" s="4"/></row>' +
            '<row r="3"><c r="A3" t="inlineStr"><is><t>Bandages</t></is></c></row>',
        },
        ['Stock'],
      ),
      name: 'stock.xlsx',
    });
    assert.equal(result.text, 'Sheet: Stock\nItem\nBandages');
  });
});

// --- PowerPoint ------------------------------------------------------------

describe('PowerPoint', () => {
  test('slides are numbered and kept in presentation order', async () => {
    const slides = Array.from({ length: 11 }, (_, index) => [`Point ${index + 1}`]);
    const result = await extractDocumentText({ bytes: pptxOf(slides), name: 'board.pptx' });

    assert.equal(result.format, 'pptx');
    // slide10 must not sort between slide1 and slide2.
    assert.ok(result.text.indexOf('Slide 2') < result.text.indexOf('Slide 10'));
    assert.match(result.text, /Slide 11\nPoint 11/);
  });
});

// --- boundaries ------------------------------------------------------------

describe('Limits and refusals', () => {
  test('a long document is paged rather than returned whole', async () => {
    const paragraphs = Array.from({ length: 400 }, (_, index) => `<w:p><w:r><w:t>Clause ${index} of the agreement.</w:t></w:r></w:p>`).join('');
    const bytes = docxOf(paragraphs);

    const first = await extractDocumentText({ bytes, name: 'long.docx', maxCharacters: 500 });
    assert.equal(first.startCharacter, 0);
    assert.equal(first.returnedCharacters, 500);
    assert.equal(first.truncated, true);
    assert.equal(first.nextStartCharacter, 500);
    assert.ok(first.totalCharacters > 500);

    const second = await extractDocumentText({
      bytes, name: 'long.docx', startCharacter: first.nextStartCharacter, maxCharacters: 500,
    });
    assert.equal(second.startCharacter, 500);
    assert.notEqual(second.text, first.text);
    assert.equal(second.totalCharacters, first.totalCharacters);
  });

  test('an archive that expands beyond the limit is refused before it is inflated', async () => {
    // 24 MB of zeros compresses to almost nothing. The download cap says
    // nothing about what a ZIP turns into once opened.
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(25 * 1024 * 1024) });
    assert.ok(bomb.byteLength < 1024 * 1024, 'the fixture should be small on disk');

    await assert.rejects(
      extractDocumentText({ bytes: bomb, name: 'bomb.docx' }),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'file_too_large');
        return true;
      },
    );
  });

  test('the pre-2007 Office formats are refused with something the Director can act on', async () => {
    await assert.rejects(
      extractDocumentText({ bytes: utf8('old binary'), name: 'contract.doc' }),
      (err: Error & { code?: string; detail?: string }) => {
        assert.equal(err.code, 'unsupported_file_type');
        assert.match(err.detail ?? '', /\.docx/);
        return true;
      },
    );
  });

  test('anything else is still refused', async () => {
    await assert.rejects(
      extractDocumentText({ bytes: utf8('MZ'), name: 'setup.exe' }),
      /cannot safely read|unsupported/i,
    );
  });

  test('plain text still goes through the same door', async () => {
    const result = await extractDocumentText({ bytes: utf8('Just a note.'), name: 'note.txt' });
    assert.equal(result.format, 'text');
    assert.equal(result.text, 'Just a note.');
    assert.equal(result.truncated, false);
  });
});
