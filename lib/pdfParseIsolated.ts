import { spawn } from 'child_process'

// pdf-parse's vendored pdf.js throws a spurious "Invalid number: e (charCode 101)"
// (or similar) error on well-formed PDFs once @supabase/supabase-js's createClient()
// has run anywhere earlier in the same process — reproduced directly: the exact same
// buffer parses cleanly every time in a fresh process, and fails every time once a
// Supabase client has been created in-process, independent of require/import style,
// timing, or an actual network call happening. Root mechanism unconfirmed; running
// the parse in a throwaway child process reliably sidesteps it.
const CHILD_SCRIPT = `
let chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', async () => {
  try {
    const buffer = Buffer.concat(chunks)
    const pdfParse = require('pdf-parse')
    const result = await pdfParse(buffer)
    process.stdout.write(JSON.stringify({ ok: true, text: result.text || '' }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, message: e && e.message ? e.message : String(e) }))
  }
})
`

export async function parsePdfTextIsolated(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (!stdout.trim()) {
        reject(new Error(`pdf-parse child process produced no output (exit ${code}). stderr: ${stderr}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.ok) resolve(parsed.text as string)
        else reject(new Error(parsed.message || 'pdf-parse child process failed'))
      } catch {
        reject(new Error(`Failed to parse pdf-parse child process output: ${stdout}`))
      }
    })

    child.stdin.write(buffer)
    child.stdin.end()
  })
}
