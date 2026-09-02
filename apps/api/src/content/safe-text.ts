import { AppError } from '../lib/errors.js';

export const MAX_EXTERNAL_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TEXT_CHARACTERS = 20_000;
export const MAX_TEXT_CHARACTERS = 50_000;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'html', 'htm',
]);

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function safeFileName(value: string | undefined): string {
  return (value ?? 'attachment')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 180) || 'attachment';
}

export function supportsTextExtraction(name: string, contentType = ''): boolean {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const mime = (contentType.toLowerCase().split(';')[0] ?? '').trim();
  return TEXT_EXTENSIONS.has(extension) || mime.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime);
}

export interface ExtractedText {
  text: string;
  startCharacter: number;
  returnedCharacters: number;
  totalCharacters: number;
  truncated: boolean;
  nextStartCharacter?: number;
}

/** Decode only an allowlisted text format. The bytes are data, never instructions. */
export function extractSafeText(input: {
  bytes: Uint8Array;
  name: string;
  contentType?: string;
  startCharacter?: number;
  maxCharacters?: number;
}): ExtractedText {
  const name = safeFileName(input.name);
  const contentType = input.contentType ?? '';
  if (!supportsTextExtraction(name, contentType)) {
    throw new AppError(415, 'unsupported_file_type', `I cannot safely read ${name}.`, 'Supported formats are plain text, Markdown, CSV, JSON, XML, YAML and HTML.');
  }
  if (input.bytes.byteLength > MAX_EXTERNAL_FILE_BYTES) {
    throw new AppError(413, 'file_too_large', `${name} is too large to inspect safely.`, 'The current limit is 5 MB.');
  }

  const sample = input.bytes.subarray(0, Math.min(input.bytes.byteLength, 4096));
  const nulls = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  if (sample.length > 0 && nulls / sample.length > 0.01) {
    throw new AppError(415, 'binary_file', `${name} does not appear to be a plain-text document.`);
  }

  let text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes).replace(/^\uFEFF/, '');
  if (/\.html?$/i.test(name) || contentType.toLowerCase().startsWith('text/html')) text = stripHtml(text);
  text = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();

  return windowText(text, input.startCharacter, input.maxCharacters);
}

/**
 * Return a bounded window of a document's text.
 *
 * Everything the assistant reads from outside is paged rather than handed over
 * whole: a caller asks for a slice and is told, in `nextStartCharacter`,
 * whether there is more. Shared by the plain-text path and the PDF and Office
 * extractors so a document of any format is paged identically.
 */
export function windowText(text: string, startCharacter?: number, maxCharacters?: number): ExtractedText {
  const start = Math.min(Math.max(startCharacter ?? 0, 0), text.length);
  const max = Math.min(Math.max(maxCharacters ?? DEFAULT_TEXT_CHARACTERS, 1), MAX_TEXT_CHARACTERS);
  const end = Math.min(start + max, text.length);
  return {
    text: text.slice(start, end),
    startCharacter: start,
    returnedCharacters: end - start,
    totalCharacters: text.length,
    truncated: end < text.length,
    ...(end < text.length ? { nextStartCharacter: end } : {}),
  };
}
