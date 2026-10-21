import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdfTextIsolated } from './pdfParseIsolated'

/**
 * Builds a minimal, spec-compliant, uncompressed single-page PDF containing
 * the given lines of text, entirely in memory — no fixture file needed.
 */
function buildMinimalPdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  let content = '/DeviceRGB CS\n0 0 0 SC\n/F1 12 Tf\nBT\n14 TL\n25 700 Td\n'
  content += lines.map((l, i) => `(${escape(l)}) Tj${i < lines.length - 1 ? '\nT*\n' : ''}`).join('')
  content += '\nET\n'
  const contentBytes = Buffer.from(content, 'latin1')

  const objects = [
    '<<\n/Type /Catalog\n/Version /1.4\n/Pages 2 0 R\n>>',
    '<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>',
    '<<\n/Type /Page\n/MediaBox [0.0 0.0 612.0 792.0]\n/Contents 4 0 R\n/Resources 5 0 R\n/Parent 2 0 R\n>>',
    null, // stream object, built separately below
    '<<\n/Font 6 0 R\n>>',
    '<<\n/F1 7 0 R\n>>',
    '<<\n/Type /Font\n/Subtype /Type1\n/BaseFont /Courier\n/Encoding /WinAnsiEncoding\n>>',
  ]

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  let byteLen = chunks[0].length
  const offsets: number[] = [0]

  const pushObj = (num: number, body: Buffer) => {
    offsets[num] = byteLen
    const header = Buffer.from(`${num} 0 obj\n`, 'latin1')
    const footer = Buffer.from('\nendobj\n', 'latin1')
    chunks.push(header, body, footer)
    byteLen += header.length + body.length + footer.length
  }

  pushObj(1, Buffer.from(objects[0]!, 'latin1'))
  pushObj(2, Buffer.from(objects[1]!, 'latin1'))
  pushObj(3, Buffer.from(objects[2]!, 'latin1'))

  offsets[4] = byteLen
  {
    const header = Buffer.from(`4 0 obj\n<<\n/Length ${contentBytes.length}\n>>\nstream\n`, 'latin1')
    const footer = Buffer.from('\nendstream\nendobj\n', 'latin1')
    chunks.push(header, contentBytes, footer)
    byteLen += header.length + contentBytes.length + footer.length
  }

  pushObj(5, Buffer.from(objects[4]!, 'latin1'))
  pushObj(6, Buffer.from(objects[5]!, 'latin1'))
  pushObj(7, Buffer.from(objects[6]!, 'latin1'))

  const xrefStart = byteLen
  const numObjects = 8
  let xref = `xref\n0 ${numObjects}\n0000000000 65535 f \n`
  for (let i = 1; i < numObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<<\n/Root 1 0 R\n/Size ${numObjects}\n>>\nstartxref\n${xrefStart}\n%%EOF`
  chunks.push(Buffer.from(xref, 'latin1'), Buffer.from(trailer, 'latin1'))

  return Buffer.concat(chunks)
}

test('parsePdfTextIsolated: extracts text from a well-formed PDF', async () => {
  const pdf = buildMinimalPdf(['HELLO FROM A TEST PDF', 'SECOND LINE OF TEXT'])
  const text = await parsePdfTextIsolated(pdf)
  assert.ok(text.includes('HELLO FROM A TEST PDF'), `expected extracted text to contain the first line, got: ${JSON.stringify(text)}`)
  assert.ok(text.includes('SECOND LINE OF TEXT'), `expected extracted text to contain the second line, got: ${JSON.stringify(text)}`)
})

test('parsePdfTextIsolated: rejects with a real error message for garbage input, instead of hanging or crashing the process', async () => {
  const notAPdf = Buffer.from('this is not a pdf file at all', 'utf8')
  await assert.rejects(() => parsePdfTextIsolated(notAPdf))
})

// This is the actual bug the isolation fix exists for: creating a
// @supabase/supabase-js client anywhere earlier in this process reliably
// corrupts pdf-parse's vendored pdf.js for the rest of the process's
// lifetime, causing it to throw spuriously (e.g. "Invalid number: e (charCode
// 101)") on a perfectly well-formed PDF. See lib/pdfParseIsolated.ts for the
// full writeup — reproduced independently while diagnosing the original
// Corebridge failure. Isolating the parse in a child process must survive
// this exact scenario, or the fix isn't actually fixing anything.
test('parsePdfTextIsolated: still succeeds after a @supabase/supabase-js client has been created in this process', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  // Deliberately fake/unreachable credentials — the corrupting side effect
  // happens on client *construction*, not on any real network call.
  createClient('https://example.invalid.supabase.co', 'fake-anon-key')

  const pdf = buildMinimalPdf(['STILL WORKS AFTER SUPABASE CLIENT CREATION'])
  const text = await parsePdfTextIsolated(pdf)
  assert.ok(
    text.includes('STILL WORKS AFTER SUPABASE CLIENT CREATION'),
    `expected extracted text after supabase client creation, got: ${JSON.stringify(text)}`
  )
})
