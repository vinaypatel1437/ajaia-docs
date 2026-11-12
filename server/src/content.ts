import sanitizeHtml from 'sanitize-html';
import mammoth from 'mammoth';
import { marked } from 'marked';
import TurndownService from 'turndown';
import path from 'node:path';

/**
 * Documents are stored as HTML restricted to the node types the editor supports.
 * Everything that enters the DB (editor saves and imports) goes through here,
 * so a shared document can't carry script/style payloads to another user.
 */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'h3', 'ul', 'ol', 'li',
      'blockquote', 'code', 'pre', 'hr', 'a'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      b: 'strong', i: 'em', strike: 's', del: 's',
      h4: 'h3', h5: 'h3', h6: 'h3',
    },
  }).trim();
}

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export class UnsupportedFileError extends Error {}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

/** Convert an uploaded file to sanitized editor HTML plus a suggested title. */
export async function fileToDocument(filename: string, buffer: Buffer): Promise<{ title: string; html: string }> {
  const ext = path.extname(filename).toLowerCase();
  const title = path.basename(filename, path.extname(filename)).trim().slice(0, 200) || 'Imported document';
  let html: string;
  switch (ext) {
    case '.txt':
      html = textToHtml(buffer.toString('utf8'));
      break;
    case '.md':
    case '.markdown':
      html = await marked.parse(buffer.toString('utf8'));
      break;
    case '.docx': {
      const result = await mammoth.convertToHtml({ buffer });
      html = result.value;
      break;
    }
    default:
      throw new UnsupportedFileError(`Unsupported file type "${ext || 'none'}". Use .txt, .md or .docx.`);
  }
  return { title, html: cleanHtml(html) };
}

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
// Markdown has no underline; keep it as inline HTML rather than silently dropping it.
turndown.keep(['u']);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
