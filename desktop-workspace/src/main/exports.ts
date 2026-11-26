import { AlignmentType, convertMillimetersToTwip, Document, HeadingLevel, ImageRun, LineRuleType, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { marked, type Token, type Tokens } from 'marked';
import { PDFArray, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import sanitizeHtml from 'sanitize-html';
import { defaultMarkdownLayout, type Annotation, type MarkdownLayout } from '../shared/contracts';

const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

function safeMarkup(value: string) {
  return sanitizeHtml(value, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 's', 'del', 'input'],
    allowedAttributes: {
      a: ['href', 'title'], img: ['src', 'alt', 'title'],
      input: ['type', 'checked', 'disabled'], td: ['align'], th: ['align'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(frame.attribs.src ?? ''),
  });
}

export function markdownPrintHtml(title: string, source: string, layout = defaultMarkdownLayout) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
    + '<title>' + escapeHtml(title) + '</title><style>'
    + '@page{size:A4;margin:14mm 12mm}body{font:' + layout.fontSize + 'px/' + layout.lineHeight + ' "Microsoft YaHei","Segoe UI",sans-serif;color:#15171c;margin:0}'
    + 'p{margin:0 0 ' + layout.paragraphGap + 'px}body>p{text-indent:' + (layout.indentParagraphs ? '2em' : '0') + '}'
    + 'h1,h2,h3{line-height:1.35;break-after:avoid}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}'
    + 'td,th{border:1px solid #b9c1cc;padding:4px 7px}pre{white-space:pre-wrap;background:#f2f4f8;padding:9px}'
    + 'a{color:#2d55b6}blockquote{border-left:3px solid #b7c4e2;padding-left:10px;margin-left:0}'
    + '</style><body>' + safeMarkup(marked.parse(source, { async: false })) + '</body></html>';
}

type Run = TextRun | ImageRun;
type Formatting = { bold?: boolean; italics?: boolean; strike?: boolean; color?: string };

function imageRun(token: Tokens.Image): Run {
  const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(token.href);
  if (!match) return new TextRun({ text: '[图片：' + (token.text || token.href) + ']' });
  const data = Buffer.from(match[2], 'base64');
  return new ImageRun({ type: match[1] === 'jpeg' ? 'jpg' : match[1] as 'png' | 'gif', data, transformation: { width: 400, height: 260 } });
}

function inline(tokens: Token[], formatting: Formatting = {}): Run[] {
  return tokens.flatMap((token): Run[] => {
    switch (token.type) {
      case 'strong': return inline((token as Tokens.Strong).tokens, { ...formatting, bold: true });
      case 'em': return inline((token as Tokens.Em).tokens, { ...formatting, italics: true });
      case 'del': return inline((token as Tokens.Del).tokens, { ...formatting, strike: true });
      case 'link': return inline((token as Tokens.Link).tokens, { ...formatting, color: '3154AD' });
      case 'image': return [imageRun(token as Tokens.Image)];
      case 'br': return [new TextRun({ break: 1 })];
      case 'codespan': return [new TextRun({ ...formatting, text: (token as Tokens.Codespan).text, font: 'Consolas' })];
      default: {
        const text = (token as Tokens.Text).text;
        return text ? [new TextRun({ ...formatting, text })] : [];
      }
    }
  });
}

function tableRow(items: Tokens.TableCell[], header: boolean) {
  return new TableRow({
    tableHeader: header,
    children: items.map((cell) => new TableCell({
      children: [new Paragraph({
        alignment: cell.align === 'center' ? AlignmentType.CENTER : cell.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: inline(cell.tokens, { bold: header }),
      })],
    })),
  });
}

function blocks(tokens: Token[], firstLine?: number): (Paragraph | Table)[] {
  return tokens.flatMap((token): (Paragraph | Table)[] => {
    switch (token.type) {
      case 'heading': {
        const item = token as Tokens.Heading;
        return [new Paragraph({ heading: headings[item.depth - 1], children: inline(item.tokens) })];
      }
      case 'paragraph':
      case 'text': {
        const item = token as Tokens.Paragraph;
        return [new Paragraph({
          children: item.tokens ? inline(item.tokens) : [new TextRun(item.text)],
          indent: firstLine === undefined ? undefined : { firstLine },
        })];
      }
      case 'blockquote': return blocks((token as Tokens.Blockquote).tokens);
      case 'list': {
        const item = token as Tokens.List;
        return item.items.flatMap((entry, index) => {
          const marker = entry.task ? (entry.checked ? '☑ ' : '☐ ') : item.ordered ? String(Number(item.start) + index) + '. ' : '• ';
          const heading = entry.tokens.find((child) => child.type === 'text' || child.type === 'paragraph') as Tokens.Paragraph | undefined;
          const first = new Paragraph({ children: [new TextRun(marker), ...inline(heading?.tokens ?? [])], indent: { left: 360 } });
          return [first, ...blocks(entry.tokens.filter((child) => child !== heading))];
        });
      }
      case 'table': {
        const table = token as Tokens.Table;
        return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [tableRow(table.header, true), ...table.rows.map((row) => tableRow(row, false))] })];
      }
      case 'code': return (token as Tokens.Code).text.split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }));
      case 'hr': return [new Paragraph('―')];
      default: return [];
    }
  });
}

export async function markdownDocx(title: string, markdown: string, layout: MarkdownLayout = defaultMarkdownLayout) {
  const mm = convertMillimetersToTwip;
  return Packer.toBuffer(new Document({
    title,
    styles: { default: { document: {
      run: { font: 'Microsoft YaHei', size: Math.round(layout.fontSize * 1.5) },
      paragraph: { spacing: { after: layout.paragraphGap * 15, line: Math.round(layout.lineHeight * 240), lineRule: LineRuleType.AUTO } },
    } } },
    sections: [{
      properties: { page: {
        size: { width: mm(210), height: mm(297) },
        margin: { top: mm(14), bottom: mm(14), left: mm(12), right: mm(12) },
      } },
      children: blocks(marked.lexer(markdown), layout.indentParagraphs ? layout.fontSize * 30 : undefined),
    }],
  }));
}

export async function annotatedPdf(bytes: Uint8Array, annotations: Annotation[]) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  for (const annotation of annotations) {
    if (annotation.anchor.type !== 'pdf') continue;
    const page = pages[annotation.anchor.page - 1];
    if (!page) throw new Error('有批注指向不存在的 PDF 页。');
    const box = page.getCropBox();
    const { x, y } = annotation.anchor.rect;
    const width = Math.min(18, box.width);
    const height = Math.min(18, box.height);
    const left = box.x + Math.max(0, Math.min(x * box.width, box.width - width));
    const top = box.y + Math.min(box.height, Math.max(box.height * (1 - y), height));
    const note = pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [left, top - height, left + width, top],
      Contents: PDFHexString.fromText(annotation.text),
      T: PDFHexString.fromText('工作空间'),
      NM: PDFHexString.fromText(annotation.id),
      Name: 'Comment',
      C: [0.99, 0.78, 0.23],
      F: 4,
      Open: false,
    });
    const reference = pdf.context.register(note);
    const key = PDFName.of('Annots');
    const annots = page.node.lookupMaybe(key, PDFArray);
    if (annots) annots.push(reference);
    else page.node.set(key, pdf.context.obj([reference]));
  }
  return pdf.save();
}
