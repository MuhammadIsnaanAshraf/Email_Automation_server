import Papa from 'papaparse'
import ExcelJS from 'exceljs'

/* Turns an uploaded spreadsheet buffer into a normalized shape:
     { headers: string[], rows: string[][] }
   where `rows` are the data lines (header excluded) as arrays of cell strings.
   Supports CSV/TSV (papaparse) and XLSX/XLS (exceljs). The caller then maps
   headers → email/name/company and validates each row. */

export const MAX_ROWS = 50_000

export class SheetParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SheetParseError'
  }
}

function isExcel(filename = '', mimetype = '') {
  const lower = filename.toLowerCase()
  return (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    mimetype.includes('spreadsheetml') ||
    mimetype === 'application/vnd.ms-excel'
  )
}

function cellToString(value) {
  if (value == null) return ''
  // exceljs returns objects for rich text / hyperlinks / formula results.
  if (typeof value === 'object') {
    if (value.text) return String(value.text)
    if (value.result != null) return String(value.result)
    if (value.hyperlink) return String(value.hyperlink)
    if (value instanceof Date) return value.toISOString()
    return ''
  }
  return String(value).trim()
}

async function parseExcel(buffer) {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch {
    throw new SheetParseError('Could not read the Excel file. It may be corrupt or password-protected.')
  }
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new SheetParseError('The workbook has no sheets.')

  const matrix = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-indexed (values[0] is undefined); slice it off.
    const cells = Array.isArray(row.values) ? row.values.slice(1) : []
    matrix.push(cells.map(cellToString))
  })
  return matrix
}

function parseDelimited(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '') // strip BOM
  const result = Papa.parse(text, {
    header: false,
    skipEmptyLines: 'greedy',
    // let papaparse sniff comma vs tab vs semicolon
  })
  if (result.errors?.length) {
    const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes')
    if (fatal) throw new SheetParseError(`Could not parse the file: ${fatal.message}`)
  }
  return result.data.map((row) => row.map((c) => (c == null ? '' : String(c).trim())))
}

export async function parseSheet(buffer, filename, mimetype) {
  if (!buffer || buffer.length === 0) {
    throw new SheetParseError('The uploaded file is empty.')
  }

  const matrix = isExcel(filename, mimetype) ? await parseExcel(buffer) : parseDelimited(buffer)

  // Drop leading fully-empty rows, then take the first non-empty row as headers.
  const nonEmpty = matrix.filter((row) => row.some((cell) => cell !== ''))
  if (nonEmpty.length === 0) {
    throw new SheetParseError('The file has no data.')
  }

  const [headerRow, ...dataRows] = nonEmpty
  const headers = headerRow.map((h) => h.trim())

  if (dataRows.length === 0) {
    throw new SheetParseError('The file has a header row but no data rows.')
  }
  if (dataRows.length > MAX_ROWS) {
    throw new SheetParseError(`Too many rows (${dataRows.length}). The limit is ${MAX_ROWS}.`)
  }

  return { headers, rows: dataRows }
}
