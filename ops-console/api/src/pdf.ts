/**
 * A minimal PDF writer (A4, Helvetica, text and lines): enough for invoices, with no dependencies.
 * Coordinates are in points from the bottom-left corner (A4 = 595 x 842).
 */
export type PdfOp =
    | { t: 'text'; x: number; y: number; text: string; size?: number; bold?: boolean; gray?: number; align?: 'left' | 'right' }
    | { t: 'line'; x1: number; y1: number; x2: number; y2: number; gray?: number };

// Helvetica glyph widths (per 1000 em) for the characters invoices use; others fall back to 556.
const W: Record<string, number> = { ' ': 278, '.': 278, ',': 278, '-': 333, ':': 278, '/': 278, '(': 333, ')': 333, '@': 1015, '#': 556, '*': 389,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, R: 722, I: 278, i: 222, l: 222, j: 222, t: 278, f: 278, r: 333,
    m: 833, w: 722, M: 833, W: 944, '•': 350, '–': 556 };
const width = (s: string, size: number, bold?: boolean) => [...s].reduce((a, ch) => a + (W[ch] ?? 556), 0) * size / 1000 * (bold ? 1.05 : 1);

/** Latin-1 text for a PDF string (WinAnsi): escape ( ) \ and map a few typographic characters. */
function pdfString(s: string): string {
    const map: Record<string, string> = { '•': '\\225', '–': '\\226', '—': '\\227', '’': "'", '‘': "'", '“': '"', '”': '"' };
    let out = '';
    for (const ch of s) {
        if (map[ch]) out += map[ch];
        else if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
        else if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 255) out += '?';
        else out += ch;
    }
    return `(${out})`;
}

function content(ops: PdfOp[]): string {
    const lines: string[] = [];
    for (const o of ops) {
        if (o.t === 'line') {
            lines.push(`${(o.gray ?? 0.8).toFixed(2)} G 0.6 w ${o.x1} ${o.y1} m ${o.x2} ${o.y2} l S`);
        } else {
            const size = o.size ?? 10;
            const x = o.align === 'right' ? o.x - width(o.text, size, o.bold) : o.x;
            lines.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${(o.gray ?? 0).toFixed(2)} g ${x.toFixed(2)} ${o.y} Td ${pdfString(o.text)} Tj ET`);
        }
    }
    return lines.join('\n');
}

/** Build a PDF with one page per list of operations. */
export function makePdf(pages: PdfOp[][], title = 'Document'): Buffer {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const catalog = add('');            // 1, filled below
    const pagesId = add('');            // 2
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of pages) {
        const stream = content(ops);
        const c = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
        kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${pdfString(title)} /Producer (Ops Console) >>`);
    let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}
