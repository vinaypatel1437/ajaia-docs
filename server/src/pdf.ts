import PDFDocument from 'pdfkit';
import { parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode, type Element } from 'domhandler';

/**
 * Renders stored document HTML (already restricted by the sanitizer to the editor's
 * schema) into a real, text-based PDF: selectable text, vector rules, page numbers.
 *
 * Uses PDF's built-in Helvetica/Courier fonts, so no font files ship with the app.
 * Those fonts cover Latin text (WinAnsi); other scripts would need an embedded font.
 */

const PAGE = { size: 'A4' as const, margin: 64 };
const COLOR = { text: '#1d2939', heading: '#101828', muted: '#667085', rule: '#d0d5dd', codeBg: '#f2f4f7', quoteBar: '#c7d2fe' };
const BODY_SIZE = 11;
const LINE_GAP = 3;
const HEADING = { h1: 22, h2: 17, h3: 14 } as const;

interface Style { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; link?: string }
interface Run extends Style { text: string }
interface Ctx { indent: number; color: string; size: number; baseBold?: boolean; italic?: boolean }

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr']);

function font(style: Style) {
  if (style.code) return 'Courier';
  if (style.bold && style.italic) return 'Helvetica-BoldOblique';
  if (style.bold) return 'Helvetica-Bold';
  if (style.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Flatten inline children into styled text runs. */
function collectRuns(nodes: ChildNode[], style: Style = {}, out: Run[] = []): Run[] {
  for (const node of nodes) {
    if (isText(node)) {
      const text = toWinAnsi(node.data.replace(/\s+/g, ' '));
      if (text) out.push({ ...style, text });
    } else if (isTag(node)) {
      const tag = node.name;
      if (BLOCK_TAGS.has(tag)) continue; // nested blocks are rendered separately
      if (tag === 'br') { out.push({ ...style, text: '\n' }); continue; }
      const next: Style = {
        ...style,
        bold: style.bold || tag === 'strong',
        italic: style.italic || tag === 'em',
        underline: style.underline || tag === 'u',
        strike: style.strike || tag === 's',
        code: style.code || tag === 'code',
        link: tag === 'a' ? node.attribs.href : style.link,
      };
      collectRuns(node.children, next, out);
    }
  }
  return out;
}

/** Trim whitespace at paragraph edges, which HTML collapses but PDF would print. */
function tidy(runs: Run[]): Run[] {
  const r = runs.map((x) => ({ ...x }));
  while (r.length && !r[0].text.trim() && r[0].text !== '\n') r.shift();
  while (r.length && !r[r.length - 1].text.trim()) r.pop();
  if (r.length) {
    r[0].text = r[0].text.replace(/^ +/, '');
    r[r.length - 1].text = r[r.length - 1].text.replace(/ +$/, '');
  }
  return r;
}

export async function renderPdf(title: string, html: string, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: PAGE.size, margin: PAGE.margin, bufferPages: true, compress: opts.compress ?? true,
    info: { Title: title, Creator: 'Ajaia Docs' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const fullWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  /** Write runs as one flowing paragraph starting at the given indent. */
  const writeRuns = (runs: Run[], ctx: Ctx) => {
    const clean = tidy(runs);
    if (!clean.length) { doc.moveDown(0.4); return; }
    const x = left + ctx.indent;
    const width = fullWidth - ctx.indent;
    clean.forEach((run, i) => {
      const style = { ...run, bold: run.bold || ctx.baseBold, italic: run.italic || ctx.italic };
      doc.font(font(style)).fontSize(run.code ? ctx.size - 1 : ctx.size)
        .fillColor(run.link ? '#4f46e5' : ctx.color);
      const options = {
        width, lineGap: LINE_GAP, continued: i < clean.length - 1,
        underline: !!run.underline || !!run.link, strike: !!run.strike, link: run.link,
      };
      if (i === 0) doc.text(run.text, x, doc.y, options);
      else doc.text(run.text, options);
    });
  };

  const ensureSpace = (height: number) => {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
  };

  const renderBlocks = (nodes: ChildNode[], ctx: Ctx) => {
    // Inline content sitting directly inside a container (e.g. <li>text</li>) forms one paragraph.
    let pending: ChildNode[] = [];
    const flush = () => {
      if (pending.length) { writeRuns(collectRuns(pending), ctx); pending = []; }
    };

    for (const node of nodes) {
      if (!isTag(node) || !BLOCK_TAGS.has(node.name)) { pending.push(node); continue; }
      flush();
      renderBlock(node, ctx);
    }
    flush();
  };

  const renderBlock = (el: Element, ctx: Ctx) => {
    switch (el.name) {
      case 'h1': case 'h2': case 'h3': {
        const size = HEADING[el.name];
        doc.moveDown(el.name === 'h1' ? 0.6 : 0.5);
        ensureSpace(size * 2.5); // keep headings with their next line
        writeRuns(collectRuns(el.children), { ...ctx, size, color: COLOR.heading, baseBold: true });
        doc.moveDown(0.35);
        break;
      }
      case 'p':
        writeRuns(collectRuns(el.children), ctx);
        doc.moveDown(0.5);
        break;
      case 'ul': case 'ol': {
        let n = 0;
        for (const li of el.children) {
          if (!isTag(li) || li.name !== 'li') continue;
          n += 1;
          // Nested bullet lists use a dash: WinAnsi fonts have no hollow bullet glyph.
          const marker = el.name === 'ol' ? `${n}.` : ctx.indent > 0 ? '–' : '•';
          ensureSpace(ctx.size * 1.6);
          const y = doc.y;
          const isBullet = marker === '•';
          doc.font('Helvetica').fontSize(isBullet ? ctx.size + 3 : ctx.size).fillColor(COLOR.muted)
            .text(marker, left + ctx.indent, isBullet ? y - 2 : y, { width: 16, align: 'right', lineBreak: false });
          doc.y = y;
          // List items hold <p> blocks (TipTap), nested lists, or bare inline content (imports).
          const inner: Ctx = { ...ctx, indent: ctx.indent + 22 };
          const inline: ChildNode[] = [];
          const flushInline = () => {
            if (inline.length) { writeRuns(collectRuns(inline.splice(0)), inner); doc.moveDown(0.15); }
          };
          for (const child of li.children) {
            if (isTag(child) && child.name === 'p') {
              flushInline();
              writeRuns(collectRuns(child.children), inner);
              doc.moveDown(0.15);
            } else if (isTag(child) && BLOCK_TAGS.has(child.name)) {
              flushInline();
              renderBlock(child, inner);
            } else {
              inline.push(child);
            }
          }
          flushInline();
        }
        doc.moveDown(0.35);
        break;
      }
      case 'blockquote': {
        const startY = doc.y;
        const startPage = doc.bufferedPageRange().count;
        renderBlocks(el.children, { ...ctx, indent: ctx.indent + 14, color: COLOR.muted, italic: true });
        // Draw the quote bar if the quote stayed on one page (otherwise skip; still readable).
        if (doc.bufferedPageRange().count === startPage) {
          doc.save().rect(left + ctx.indent, startY, 2.5, Math.max(doc.y - startY - 6, 10)).fill(COLOR.quoteBar).restore();
        }
        doc.moveDown(0.2);
        break;
      }
      case 'pre': {
        const raw = toWinAnsi(textOf(el).replace(/\n$/, ''));
        doc.font('Courier').fontSize(ctx.size - 1);
        const width = fullWidth - ctx.indent - 20;
        const height = doc.heightOfString(raw, { width, lineGap: 2 }) + 16;
        ensureSpace(height);
        const y = doc.y;
        doc.save().roundedRect(left + ctx.indent, y, fullWidth - ctx.indent, height, 4).fill(COLOR.codeBg).restore();
        doc.fillColor(COLOR.text).text(raw, left + ctx.indent + 10, y + 8, { width, lineGap: 2 });
        doc.y = y + height;
        doc.moveDown(0.5);
        break;
      }
      case 'hr': {
        doc.fontSize(BODY_SIZE).moveDown(0.6);
        const y = doc.y;
        doc.save().moveTo(left + ctx.indent, y).lineTo(left + fullWidth, y).lineWidth(0.75).strokeColor(COLOR.rule).stroke().restore();
        doc.y = y;
        doc.moveDown(0.8);
        break;
      }
      default:
        renderBlocks(el.children, ctx);
    }
  };

  // Title + rule
  doc.font('Helvetica-Bold').fontSize(24).fillColor(COLOR.heading).text(toWinAnsi(title), left, doc.y, { width: fullWidth });
  doc.moveDown(0.3);
  const ruleY = doc.y;
  doc.save().moveTo(left, ruleY).lineTo(left + fullWidth, ruleY).lineWidth(0.75).strokeColor(COLOR.rule).stroke().restore();
  doc.y = ruleY;
  doc.moveDown(1);

  renderBlocks(parseDocument(html).children, { indent: 0, color: COLOR.text, size: BODY_SIZE });

  // Footer: page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing inside the bottom margin
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted)
      .text(`${toWinAnsi(title)}  ·  Page ${i + 1} of ${range.count}`, left, doc.page.height - 36, { width: fullWidth, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}

function textOf(node: ChildNode): string {
  if (isText(node)) return node.data;
  if (isTag(node)) return node.children.map(textOf).join('');
  return '';
}

/** Characters encodable by the PDF standard fonts (Windows-1252), beyond Latin-1. */
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS: Record<string, string> = { '→': '->', '←': '<-', '✓': 'v', '≥': '>=', '≤': '<=', '≠': '!=', '\u00a0': ' ' };

/** Map text to what Helvetica/Courier can render; anything else becomes '?' rather than garbage. */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || ch === '\n' || CP1252_EXTRA.has(ch)) out += ch;
    else out += REPLACEMENTS[ch] ?? '?';
  }
  return out;
}
