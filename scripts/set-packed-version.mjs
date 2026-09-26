/**
 * Stamp the packed application's version to match package.json.
 *
 * electron-builder copies package.json into resources/app.asar, and Electron's
 * app.getVersion() reads it from there. That is the only place the shell's version
 * comes from, and it is what the update check compares against the published tag:
 *
 *     hasUpdate = compare(latest, app.getVersion()) > 0
 *
 * So when the source version is bumped but the packed build is not rebuilt, the app
 * keeps announcing an update that is really itself. This rewrites that one value.
 *
 * It is an in-place byte patch, not a repack. The version is the only thing that
 * changes and it keeps its length, so every size and offset in the asar header stays
 * valid and the 600 kB archive is never rewritten. The patched archive is re-read
 * through the asar API afterwards to prove the header still resolves.
 *
 * Usage: node scripts/set-packed-version.mjs [path/to/app.asar]
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const wanted = String(source.version)
const archive = resolve(process.argv[2] ?? join(root, 'release', 'win-unpacked', 'resources', 'app.asar'))

const bytes = readFileSync(archive)
const text = bytes.toString('latin1')

// Anchor on the packed package.json itself rather than on a bare version string: the
// bundle also contains the word "version" in unrelated code. The name field precedes
// the version field in the file electron-builder writes.
const anchor = text.indexOf('"name": "kokonaharness"')
if (anchor < 0) {
  console.error(`[x] ${archive} does not look like a KokonaHarness asar (no packed package.json).`)
  process.exit(1)
}

const window = text.slice(anchor, anchor + 512)
const found = /"version":\s*"([^"]+)"/.exec(window)
if (found === null) {
  console.error('[x] No version field found after the packed package.json name field.')
  process.exit(1)
}

const current = found[1]
if (current === wanted) {
  console.log(`[=] Already ${wanted}. Nothing to do.`)
  process.exit(0)
}
if (current.length !== wanted.length) {
  console.error(
    `[x] Cannot patch in place: "${current}" and "${wanted}" differ in length, which would ` +
      'shift every offset in the asar header. Rebuild with `npm run pack` instead.'
  )
  process.exit(1)
}

// The version token inside the matched field, located in the whole-archive text.
const fieldStart = anchor + found.index
const valueStart = fieldStart + found[0].lastIndexOf(`"${current}"`) + 1
const patched = Buffer.from(text, 'latin1')
patched.write(wanted, valueStart, 'latin1')

// Prove it before touching the real file: the archive must still parse and must
// report the new version.
const scratch = `${archive}.probe`
writeFileSync(scratch, patched)
try {
  const asar = require('@electron/asar')
  const packed = JSON.parse(asar.extractFile(scratch, 'package.json').toString('utf8'))
  if (packed.version !== wanted) {
    throw new Error(`the re-read archive reports ${String(packed.version)}`)
  }
  const listed = asar.listPackage(scratch).length
  console.log(`[.] Verified on a copy: ${listed} entries, packed version ${packed.version}`)
} catch (error) {
  console.error(`[x] Refusing to patch ${archive}: ${error.message}`)
  process.exit(1)
} finally {
  try {
    unlinkSync(scratch)
  } catch {
    // already gone
  }
}

writeFileSync(archive, patched)
console.log(`[ok] ${archive}`)
console.log(`     version ${current} -> ${wanted} (${bytes.length} bytes, unchanged)`)
