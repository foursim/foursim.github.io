/**
 * 极简 XLSX 写出器（**零依赖**，只用 node 内置模块）
 *
 * ## 为什么要自己写
 * 这个项目的纪律是"纯静态 + 零外部依赖 + 可判据验证"。表格要给业务方看，**Excel 一个文件最省事**
 * （多张 sheet、可透视、可筛选），但主流做法要引 `exceljs`/`xlsx` 这类包 —— 而 xlsx 本质就是
 * 一个装着 XML 的 ZIP，用 STORE（不压缩）+ 最小 XML 就能写出来，几十行的事，不值得引依赖。
 *
 * ## 实现约束（够用即止）
 * - 只写**字符串与数字**（不写公式、日期序列号、合并单元格、图表）；
 * - 字符串用 `t="inlineStr"` 内联，**不建共享字符串表**（少一个部件、少一类 bug）；
 * - 压缩方式用 STORE（不压缩）：文件偏大（约 3~5 倍），但不需要 zlib 之外的东西，且 Excel 完全认；
 * - 表头加粗 + 冻结首行 + 自动筛选，列宽按内容估。
 *
 * ## 怎么验证它没写坏
 * 本文件不自我检验 —— 由 `tools/export-tables.mjs` 用 **python zipfile + ElementTree** 反向解包校验
 * （能解开、每个 sheet 的 XML 合法、行列数对得上）。只看"文件生成了"不算验证。
 */
import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- ZIP（STORE 或 DEFLATE） ----------
/**
 * @param {{name:string, data:Buffer, compress?:boolean}[]} entries
 */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const crc = crc32(raw);
    // 小文件用 STORE（写起来简单、调错容易）；大表用 DEFLATE 压一下，否则 xlsx 会大得离谱
    const useDeflate = e.compress !== false && raw.length > 4096;
    const body = useDeflate ? deflateRawSync(raw) : raw;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2821, 12); // date（2010-01-01，固定值 ⇒ 同输入同输出）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x2821, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------- XML 片段 ----------
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Excel 不接受 XML 1.0 之外的控制字符（CSV 里偶尔混进来的 \r 也会让文件打不开）
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (n) => {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** 数字单元格；空值写空单元格（保持列对齐，Excel 筛选才不会错位） */
function cell(ref, v) {
  if (v === null || v === undefined || v === '') return '';
  if (isNum(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

/**
 * 写一个工作簿。
 * @param {string} out 目标路径
 * @param {{name:string, columns:any[], rows:any[][], note?:string}[]} sheets
 *  - `columns` 表头文案；`rows` 与表头等长的二维数组（与 CSV 导出的数据同源，避免两套口径）
 */
export function writeXlsx(out, sheets) {
  const sheetXml = (sh) => {
    const widths = sh.columns.map((c, i) => {
      let w = String(c ?? '').length * 1.6 + 2;
      for (const r of sh.rows.slice(0, 400)) {
        const v = r[i];
        const len = (v === null || v === undefined ? '' : String(v)).length;
        // 中文字符占两个宽度
        const wide = (String(v ?? '').match(/[\u4e00-\u9fa5]/g) ?? []).length;
        w = Math.max(w, Math.min(48, len * 0.95 + wide * 1.05 + 2));
      }
      return `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`;
    }).join('');
    const head = `<row r="1">${sh.columns.map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${esc(c)}</t></is></c>`).join('')}</row>`;
    const body = sh.rows.map((r, ri) => {
      const cells = r.map((v, ci) => cell(`${colName(ci)}${ri + 2}`, v)).join('');
      return cells ? `<row r="${ri + 2}">${cells}</row>` : '';
    }).join('');
    const lastRef = `${colName(sh.columns.length - 1)}${sh.rows.length + 1}`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="14.5"/>
<cols>${widths}</cols>
<sheetData>${head}${body}</sheetData>
<autoFilter ref="A1:${lastRef}"/>
</worksheet>`;
  };

  const parts = [];
  const sheetNames = sheets.map((s, i) => (s.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, '_').slice(0, 31));
  parts.push({
    name: '[Content_Types].xml',
    compress: false,
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`, 'utf8'),
  });
  parts.push({
    name: '_rels/.rels',
    compress: false,
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'),
  });
  parts.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetNames.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`, 'utf8'),
  });
  parts.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8'),
  });
  parts.push({
    name: 'xl/styles.xml',
    compress: false,
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2F5D3A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`, 'utf8'),
  });
  sheets.forEach((sh, i) => {
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sh), 'utf8') });
  });

  fs.writeFileSync(out, zip(parts));
  return { sheets: sheets.length, bytes: fs.statSync(out).size };
}
