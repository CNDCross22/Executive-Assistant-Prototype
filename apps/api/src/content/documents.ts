import { unzipSync, strFromU8, type UnzipFileInfo } from 'fflate';
import { AppError } from '../lib/errors.js';
import {
  extractSafeText,
  MAX_EXTERNAL_FILE_BYTES,
  safeFileName,
  supportsTextExtraction,
  windowText,
  type ExtractedText,
} from './safe-text.js';

/**
 * Reading PDF and Office attachments.
 *
 * Until now Hermes refused every one of them, which meant it could see that a
 * contract had arrived but never what the contract said. The business mail it
 * exists to triage is almost entirely PDF, Word and Excel.
 *
 * The rule from the plain-text path carries over unchanged, and matters more
 * here because these parsers are far more complicated than a UTF-8 decode: the
 * bytes are data, never instructions. Nothing extracted below is executed, no
 * external reference inside a document is followed, and the result goes back
 * through the same untrusted-content boundary as any other foreign text.
 */

/** A page of text with no characters on it means an image, not an empty page. */
const MIN_MEANINGFUL_CHARACTERS = 8;

/**
 * A cap on decompressed size, checked per entry before fflate inflates it.
 *
 * An Office file is a ZIP archive, and a ZIP archive is the classic way to
 * turn a small upload into an out-of-memory kill: the 5 MB ceiling on the
 * download says nothing about what it expands to.
 */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Beyond this, no further reading is useful and the memory cost is real. */
const MAX_EXTRACTED_CHARACTERS = 2_000_000;

/** Spreadsheets can be enormous; the tail of one is rarely what was asked about. */
const MAX_ROWS_PER_SHEET = 5_000;

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';

const BY_EXTENSION: Record<string, DocumentFormat> = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
};

const BY_MIME: Record<string, DocumentFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The formats that predate OOXML. They are not ZIPs and are not supported. */
const LEGACY_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);

function extensionOf(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

function mimeOf(contentType: string): string {
  return (contentType.toLowerCase().split(';')[0] ?? '').trim();
}

/** Which of the binary document formats, if any, this file is. */
export function documentFormat(name: string, contentType = ''): DocumentFormat | null {
  return BY_EXTENSION[extensionOf(name)] ?? BY_MIME[mimeOf(contentType)] ?? null;
}

export function supportsDocumentExtraction(name: string, contentType = ''): boolean {
  return documentFormat(name, contentType) !== null;
}

/** Every format text can be read from, plain and binary alike. */
export function supportsExtraction(name: string, contentType = ''): boolean {
  return supportsTextExtraction(name, contentType) || supportsDocumentExtraction(name, contentType);
}

export const SUPPORTED_FORMATS_SENTENCE =
  'Supported formats are PDF, Word, Excel, PowerPoint, plain text, Markdown, CSV, JSON, XML, YAML and HTML.';

// --- XML -------------------------------------------------------------------

function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(Number(decimal)))
    // Last, so that a literal &amp;lt; does not decode twice into a tag.
    .replace(/&amp;/g, '&');
}

/**
 * Tidy applied to every format.
 *
 * Deliberately conservative: it must not touch a run of tabs, because in a
 * spreadsheet that run is an empty column, and closing the gap would put every
 * figure on the row under the wrong heading.
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_EXTRACTED_CHARACTERS);
}

// --- ZIP -------------------------------------------------------------------

/**
 * Unzip only the entries a format's text lives in.
 *
 * The filter runs before inflation, so an entry claiming an implausible
 * expanded size is refused rather than decompressed.
 */
function openArchive(
  bytes: Uint8Array,
  name: string,
  wanted: (entry: string) => boolean,
): Record<string, Uint8Array> {
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (file: UnzipFileInfo) => {
        if (!wanted(file.name)) return false;
        total += file.originalSize;
        if (file.originalSize > MAX_ENTRY_BYTES || total > MAX_ARCHIVE_BYTES) {
          throw new AppError(413, 'file_too_large', `${name} expands to more than this assistant will open.`);
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      422,
      'unreadable_document',
      `I could not open ${name}.`,
      'The file may be corrupt, password-protected, or not the format its name suggests.',
    );
  }
}

function entryText(archive: Record<string, Uint8Array>, entry: string): string {
  const bytes = archive[entry];
  return bytes ? strFromU8(bytes) : '';
}

/** Sort slide1, slide2, slide10 the way a person would rather than the way a string sort does. */
function byTrailingNumber(a: string, b: string): number {
  const number = (value: string): number => Number(value.match(/(\d+)\D*$/)?.[1] ?? 0);
  return number(a) - number(b);
}

// --- Word ------------------------------------------------------------------

const WORD_TOKENS =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;

function readWord(archive: Record<string, Uint8Array>): string {
  const xml = entryText(archive, 'word/document.xml');
  let out = '';
  for (const match of xml.matchAll(WORD_TOKENS)) {
    const token = match[0];
    const content = match[1];
    if (content !== undefined) out += decodeEntities(content);
    else if (token.startsWith('<w:tab')) out += '\t';
    else if (token.startsWith('<w:br')) out += '\n';
    else if (token === '</w:tc>') out += '\t';
    else out += '\n'; // </w:p> and </w:tr>
  }
  // A cell ends with the paragraph inside it, so the walk leaves a newline
  // immediately before every cell and row separator. Repairing that belongs
  // here rather than in the shared tidy, where the same rule would merge two
  // spreadsheet rows whenever the second one began with an empty cell.
  return out.replace(/\n+\t/g, '\t').replace(/\t+\n/g, '\n');
}

// --- PowerPoint ------------------------------------------------------------

const SLIDE_TOKENS = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>/g;

function readSlides(archive: Record<string, Uint8Array>): string {
  const slides = Object.keys(archive)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort(byTrailingNumber);

  return slides
    .map((entry, index) => {
      let body = '';
      for (const match of entryText(archive, entry).matchAll(SLIDE_TOKENS)) {
        body += match[1] !== undefined ? decodeEntities(match[1]) : '\n';
      }
      return `Slide ${index + 1}\n${body.trim()}`;
    })
    .join('\n\n');
}

// --- Excel -----------------------------------------------------------------

/** "AB12" becomes 27. Used to keep a row's columns in their real positions. */
function columnIndex(reference: string): number {
  const letters = reference.match(/^([A-Z]+)/)?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readSharedStrings(archive: Record<string, Uint8Array>): string[] {
  const xml = entryText(archive, 'xl/sharedStrings.xml');
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) => {
    let value = '';
    for (const run of (item[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      value += decodeEntities(run[1] ?? '');
    }
    return value;
  });
}

function sheetNames(archive: Record<string, Uint8Array>): string[] {
  const xml = entryText(archive, 'xl/workbook.xml');
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? ''));
}

function readCell(attributes: string, body: string, shared: string[]): string {
  const type = attributes.match(/\bt="([^"]*)"/)?.[1] ?? 'n';
  if (type === 's') {
    return shared[Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? -1)] ?? '';
  }
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((run) => decodeEntities(run[1] ?? ''))
      .join('');
  }
  return decodeEntities(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
}

function readWorkbook(archive: Record<string, Uint8Array>): string {
  const shared = readSharedStrings(archive);
  const names = sheetNames(archive);
  const sheets = Object.keys(archive)
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort(byTrailingNumber);

  return sheets
    .map((entry, index) => {
      const xml = entryText(archive, entry);
      const rows: string[] = [];
      let truncated = false;

      for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (rows.length >= MAX_ROWS_PER_SHEET) {
          truncated = true;
          break;
        }
        const cells: string[] = [];
        for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attributes = cell[1] ?? '';
          const at = columnIndex(attributes.match(/\br="([^"]*)"/)?.[1] ?? '');
          // Keep a gap where the spreadsheet has one: a value under the wrong
          // heading is worse than no value at all.
          if (at >= 0) while (cells.length < at) cells.push('');
          cells.push(readCell(attributes, cell[2] ?? '', shared));
        }
        // Skip rows that exist only to carry formatting.
        if (cells.some((cell) => cell !== '')) rows.push(cells.join('\t'));
      }

      const title = names[index] ?? `Sheet ${index + 1}`;
      const note = truncated ? `\n[Only the first ${MAX_ROWS_PER_SHEET} rows of this sheet were read.]` : '';
      return `Sheet: ${title}\n${rows.join('\n')}${note}`;
    })
    .join('\n\n');
}

// --- PDF -------------------------------------------------------------------

/**
 * Imported lazily. PDF.js is by far the heaviest thing in the bundle and its
 * module-level setup is not cheap; a Director who never opens a PDF should
 * never pay for it.
 */
async function readPdf(bytes: Uint8Array, name: string): Promise<{ text: string; pages: number }> {
  const { getDocumentProxy, extractText } = await import('unpdf');

  let document;
  try {
    document = await getDocumentProxy(bytes, {
      // We want the characters and nothing else. Font programs inside a PDF
      // are the part with a history of remote-code-execution bugs, and a
      // document the Director was emailed has no business loading typefaces or
      // touching a canvas on a server that will never draw it.
      disableFontFace: true,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      // Do not let the parser reach the network for anything a file references.
      useWorkerFetch: false,
      // Read as much as is readable rather than abandoning a slightly damaged
      // file: a partly recoverable contract still tells the Director something.
      stopAtErrors: false,
      // Errors only. Warnings about damaged files belong in our logs, not stderr.
      verbosity: 0,
    });
  } catch {
    throw new AppError(
      422,
      'unreadable_document',
      `I could not open ${name}.`,
      'The file may be corrupt, password-protected, or not a PDF.',
    );
  }

  const { text } = await extractText(document, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  return { text: pages.map((page) => page.trim()).join('\n\n'), pages: pages.length };
}

// --- Entry point -----------------------------------------------------------

export interface ExtractedDocument extends ExtractedText {
  format: DocumentFormat | 'text';
  /** Present for PDFs, where page count is how people refer to a document's size. */
  pages?: number;
}

/**
 * Read bounded text out of any supported attachment.
 *
 * Callers hand over bytes they have already size-capped; this decides the
 * format, extracts, and returns the same paged window regardless of what the
 * file turned out to be.
 */
export async function extractDocumentText(input: {
  bytes: Uint8Array;
  name: string;
  contentType?: string;
  startCharacter?: number;
  maxCharacters?: number;
}): Promise<ExtractedDocument> {
  const name = safeFileName(input.name);
  const contentType = input.contentType ?? '';

  if (input.bytes.byteLength > MAX_EXTERNAL_FILE_BYTES) {
    throw new AppError(413, 'file_too_large', `${name} is too large to inspect safely.`, 'The current limit is 5 MB.');
  }

  const format = documentFormat(name, contentType);
  if (!format) {
    if (LEGACY_EXTENSIONS.has(extensionOf(name))) {
      throw new AppError(
        415,
        'unsupported_file_type',
        `I cannot read ${name}.`,
        'That is the pre-2007 Office format. Saving it as .docx, .xlsx or .pptx, or as a PDF, would let me read it.',
      );
    }
    // Plain text and its relatives, or an outright refusal.
    return { ...extractSafeText({ ...input, name }), format: 'text' };
  }

  let text: string;
  let pages: number | undefined;

  if (format === 'pdf') {
    const result = await readPdf(input.bytes, name);
    text = result.text;
    pages = result.pages;
  } else {
    const wanted =
      format === 'docx'
        ? (entry: string) => entry === 'word/document.xml'
        : format === 'pptx'
          ? (entry: string) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)
          : (entry: string) =>
            entry === 'xl/sharedStrings.xml' ||
              entry === 'xl/workbook.xml' ||
              /^xl\/worksheets\/sheet\d+\.xml$/.test(entry);

    const archive = openArchive(input.bytes, name, wanted);
    text = format === 'docx' ? readWord(archive) : format === 'pptx' ? readSlides(archive) : readWorkbook(archive);
  }

  const tidied = tidy(text);

  // A PDF of a scanned page extracts as nothing. Saying so is the whole point:
  // an empty string handed to a model is an invitation to invent the contents.
  if (tidied.length < MIN_MEANINGFUL_CHARACTERS) {
    throw new AppError(
      422,
      'no_text_layer',
      `${name} has no text I can read.`,
      format === 'pdf'
        ? 'It appears to be a scan or images of pages rather than text. This assistant does not perform optical character recognition.'
        : 'The file opened, but it contains no text — only images or empty content.',
    );
  }

  return {
    ...windowText(tidied, input.startCharacter, input.maxCharacters),
    format,
    ...(pages !== undefined ? { pages } : {}),
  };
}
