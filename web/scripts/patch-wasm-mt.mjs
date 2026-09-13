/**
 * Make the threaded wasm package loadable without a bundler.
 *
 * wasm-bindgen-rayon's worker helper does `await import('../../..')` and
 * relies on a bundler resolving that to the package entry. We serve
 * `web/public/wasm-mt` as plain files, where `../../..` is a directory and the
 * request 404s — every rayon worker then dies and the pool never starts.
 *
 * Rewriting the specifier to the real file is the whole fix. Idempotent, and a
 * no-op when the threaded build is absent.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'public/wasm-mt')

const FROM = "import('../../..')"
const TO = "import('../../../twin_wasm.js')"

if (!existsSync(DIR)) {
  console.log('note    no public/wasm-mt; nothing to patch')
  process.exit(0)
}

/** Node 20 has no stable `globSync`, and the tree is two levels deep. */
const helpers = readdirSync(resolve(DIR, 'snippets'), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name === 'workerHelpers.js')
  .map((e) => resolve(e.parentPath ?? e.path, e.name))
if (helpers.length === 0) {
  console.log('note    no workerHelpers.js under public/wasm-mt; nothing to patch')
  process.exit(0)
}

const patched = helpers.filter((file) => {
  const src = readFileSync(file, 'utf8')
  if (!src.includes(FROM)) return false
  writeFileSync(file, src.replaceAll(FROM, TO))
  return true
})

console.log(
  patched.length > 0
    ? `patched ${patched.length} worker helper(s) to import twin_wasm.js directly`
    : 'note    worker helpers already patched',
)
