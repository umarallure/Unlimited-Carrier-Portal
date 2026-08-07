// Minimal TS test bootstrap: no test framework is installed in this repo, so this
// registers a require() hook (via the existing `typescript` devDependency) that
// transpiles .ts files on the fly and resolves extensionless relative imports,
// then runs each test file passed on the command line under node:test.
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ts = require('typescript')

require.extensions['.ts'] = function (mod, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  })
  mod._compile(outputText, filename)
}

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  // tsconfig.json maps "@/*" -> "./*" (project root)
  const aliased = request.startsWith('@/') ? path.resolve(__dirname, '..', request.slice(2)) : request
  try {
    return originalResolve.call(this, aliased, ...rest)
  } catch (err) {
    if (aliased.startsWith('.') || path.isAbsolute(aliased)) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          return originalResolve.call(this, aliased + ext, ...rest)
        } catch (_) {
          // try next extension
        }
      }
    }
    throw err
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Usage: node scripts/run-ts-tests.cjs <test-file.ts> [...]')
  process.exit(1)
}
for (const file of files) {
  require(path.resolve(process.cwd(), file))
}
