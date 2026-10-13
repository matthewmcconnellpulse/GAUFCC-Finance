/**
 * A minimal .xlsx writer — multi-sheet, typed cells, no dependency.
 *
 * Why hand-rolled rather than SheetJS or ExcelJS: the exports here are plain
 * grids of strings, numbers and dates. That needs a few hundred lines of OOXML
 * and a ZIP, against ~1MB of bundle and a third-party package sitting in the
 * dependency tree of a charity's finance platform for the rest of its life.
 *
 * What it deliberately does NOT do: formulas, merged cells, charts, images,
 * styling beyond number formats and a bold header row. Anything needing those
 * wants a real library, and this should be replaced rather than extended.
 *
 * The one thing it must get right is cell TYPES. An export whose figures are
 * text is useless — it will not sum, pivot or chart, and that is the usual way
 * a hand-made spreadsheet export disappoints. Numbers are written as numbers,
 * dates as Excel serials with a date format, and account codes as text so
 * "0410" keeps its leading zero.
 */

export type CellValue = string | number | Date | null | undefined

export type CellFormat =
  /** Left as typed; numbers right-align and sum. */
  | 'auto'
  /** Forced text — account codes, period keys, anything with a leading zero. */
  | 'text'
  /** #,##0.00 with negatives in brackets, the accounting convention. */
  | 'money'
  /** Plain number, no decimals. */
  | 'integer'
  /** dd/mm/yyyy */
  | 'date'
  /** mmm-yy — month columns in the wide sheets. */
  | 'month'

export interface Column {
  /** Printed in row 1. */
  header: string
  /** Key into each row object. */
  key: string
  /** Approximate character width. */
  width?: number
  format?: CellFormat
}

export interface Sheet {
  name: string
  columns: Column[]
  rows: Array<Record<string, CellValue>>
  /**
   * Freeze the header row and add a filter across it. On by default — every
   * sheet here is a table someone will sort and filter.
   */
  table?: boolean
  /**
   * Rows of free text written above the table, for a sheet that has to
   * explain itself (the Read me, or a sheet whose source was unavailable).
   */
  notes?: string[]
}

// ── XML and cell references ──────────────────────────────────────────────────

/** Escape text for XML, and drop the control characters XML cannot carry. */
function xml(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 0 → A, 25 → Z, 26 → AA. The wide sheets run past column Z. */
export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/**
 * Excel's serial date: whole days since 1899-12-30, in the workbook's own
 * (timezone-free) calendar. The date is taken apart in LOCAL terms because
 * that is how the user typed and reads it — converting through UTC is what
 * makes a 1 October land in a spreadsheet as 30 September.
 */
function excelSerial(d: Date): number {
  const utcMidnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((utcMidnight - Date.UTC(1899, 11, 30)) / 86_400_000)
}

/**
 * Excel refuses a workbook whose sheet names are invalid or repeated, and
 * does it with an unhelpful "unreadable content" dialogue — so the names are
 * made legal here rather than trusted from the caller.
 */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((sheet, i) => {
    let name = (sheet.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31)
    if (!name) name = `Sheet${i + 1}`
    let candidate = name
    let n = 2
    while (used.has(candidate.toLowerCase())) {
      const suffix = ` (${n++})`
      candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

// ── Styles ───────────────────────────────────────────────────────────────────

// cellXfs indices, referenced as s="n" on each cell.
const STYLE_DEFAULT = 0
const STYLE_HEADER = 1
const STYLE_MONEY = 2
const STYLE_DATE = 3
const STYLE_MONTH = 4
const STYLE_TEXT = 5
const STYLE_INTEGER = 6
const STYLE_NOTE = 7

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
<numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="166" formatCode="mmm\\-yy"/>
<numFmt numFmtId="167" formatCode="#,##0"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDEBE4"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="bottom" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

function styleFor(format: CellFormat | undefined, value: CellValue): number {
  switch (format) {
    case 'money':
      return STYLE_MONEY
    case 'integer':
      return STYLE_INTEGER
    case 'date':
      return STYLE_DATE
    case 'month':
      return STYLE_MONTH
    case 'text':
      return STYLE_TEXT
    default:
      if (value instanceof Date) return STYLE_DATE
      return STYLE_DEFAULT
  }
}

// ── Sheet XML ────────────────────────────────────────────────────────────────

function cellXml(ref: string, value: CellValue, format: CellFormat | undefined): string {
  const style = styleFor(format, value)
  const s = style === STYLE_DEFAULT ? '' : ` s="${style}"`

  if (value === null || value === undefined || value === '') return ''

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return `<c r="${ref}"${s}><v>${excelSerial(value)}</v></c>`
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    // 'text' on a number means the caller wants it kept as a label (an account
    // code that happens to be all digits), so write it as a string.
    if (format === 'text') {
      return `<c r="${ref}"${s} t="inlineStr"><is><t>${xml(String(value))}</t></is></c>`
    }
    return `<c r="${ref}"${s}><v>${value}</v></c>`
  }

  // Inline strings rather than a shared-string table: a little larger on disk,
  // and it removes a whole class of index-mismatch corruption.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
}

function sheetXml(sheet: Sheet): string {
  const notes = sheet.notes ?? []
  const table = sheet.table !== false
  const headerRow = notes.length + 1
  const lastCol = columnLetter(Math.max(0, sheet.columns.length - 1))
  const lastRow = headerRow + sheet.rows.length

  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
  parts.push(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  )
  parts.push(`<dimension ref="A1:${lastCol}${Math.max(lastRow, 1)}"/>`)

  // Freeze everything above and including the header, so the column names stay
  // on screen through several thousand rows.
  if (table) {
    parts.push(
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    )
  } else {
    parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>')
  }
  parts.push('<sheetFormatPr defaultRowHeight="15"/>')

  if (sheet.columns.length > 0) {
    parts.push('<cols>')
    sheet.columns.forEach((col, i) => {
      const width = col.width ?? Math.min(40, Math.max(10, col.header.length + 2))
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
    })
    parts.push('</cols>')
  }

  parts.push('<sheetData>')

  notes.forEach((note, i) => {
    parts.push(
      `<row r="${i + 1}">${cellXml(`A${i + 1}`, note, 'auto').replace(' t="inlineStr"', ' s="7" t="inlineStr"')}</row>`,
    )
  })

  if (sheet.columns.length > 0) {
    const cells = sheet.columns
      .map((col, i) => {
        const ref = `${columnLetter(i)}${headerRow}`
        return `<c r="${ref}" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${xml(col.header)}</t></is></c>`
      })
      .join('')
    parts.push(`<row r="${headerRow}">${cells}</row>`)
  }

  sheet.rows.forEach((row, r) => {
    const rowNumber = headerRow + 1 + r
    const cells = sheet.columns
      .map((col, i) => cellXml(`${columnLetter(i)}${rowNumber}`, row[col.key], col.format))
      .join('')
    parts.push(`<row r="${rowNumber}">${cells}</row>`)
  })

  parts.push('</sheetData>')

  // autoFilter must follow sheetData — the schema is order-sensitive and Excel
  // rejects the file outright if it does not.
  if (table && sheet.columns.length > 0 && sheet.rows.length > 0) {
    parts.push(`<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>`)
  }

  parts.push('</worksheet>')
  return parts.join('')
}

// ── ZIP ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  // Available in every current browser; a workbook is still produced without
  // it, just uncompressed, so this is an optimisation and not a requirement.
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream
  if (!Compression) return null
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Compression('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

/** A ZIP container — the only part of .xlsx that is not XML. */
async function zip(entries: ZipEntry[]): Promise<Blob> {
  const chunks: Uint8Array[] = []
  const central: number[] = []
  let offset = 0
  const encoder = new TextEncoder()

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const compressed = await deflateRaw(entry.data)
    const useDeflate = compressed !== null && compressed.length < entry.data.length
    const body = useDeflate ? compressed! : entry.data
    const method = useDeflate ? 8 : 0

    const local = [
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 names
      ...u16(method),
      ...u16(0), // time
      ...u16(0), // date
      ...u32(crc),
      ...u32(body.length),
      ...u32(entry.data.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ]
    chunks.push(new Uint8Array(local), nameBytes, body)

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(body.length),
      ...u32(entry.data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
    )
    central.push(...nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralBytes = new Uint8Array(central)
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralBytes.length),
    ...u32(offset),
    ...u16(0),
  ]

  return new Blob(
    [...chunks, centralBytes, new Uint8Array(end)] as BlobPart[],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  )
}

// ── Workbook ─────────────────────────────────────────────────────────────────

export async function buildWorkbook(sheets: Sheet[]): Promise<Blob> {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet')
  const names = sheetNames(sheets)
  const encoder = new TextEncoder()

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheets.map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
    '</Types>',
  ].join('')

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    names
      .map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>'

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: encoder.encode(sheetXml(sheet)),
    })),
  ]

  return zip(entries)
}

/** Build the workbook and hand it to the browser's downloads. */
export async function downloadWorkbook(fileName: string, sheets: Sheet[]): Promise<void> {
  const blob = await buildWorkbook(sheets)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
