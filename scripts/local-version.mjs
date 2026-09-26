/**
 * Local-only version bump: keep the working copy one patch ahead of the last release.
 *
 * The failure this prevents: the code moves on but package.json still holds the version
 * that was just published, so the packed app reports the same version as the release it
 * is newer than, and the update check keeps announcing an update that is really itself.
 *
 * Rule: if the local version still equals the newest release tag and the tree has moved
 * on from that tag, bump the patch once. It is self-limiting - after the bump the local
 * version is ahead of the tag, so every later build leaves it alone until the next tag.
 *
 * This must NEVER run in CI. The released artifact has to report the version its tag
 * says, or the release is self-contradictory. CI sets CI=true, so it exits immediately.
 *
 * Wired to npm's prebuild hook, so `npm run build` and `npm run pack` both go through it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')

const log = (message) => console.log(`[local-version] ${message}`)

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

// The release artifact must match its tag. Only the developer's working copy drifts.
if (process.env.CI) {
  log('CI detected - leaving the version alone so the release matches its tag.')
  process.exit(0)
}

let released = null
try {
  released = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']).replace(/^v/i, '')
} catch {
  log('No release tag yet - nothing to compare against, leaving the version alone.')
  process.exit(0)
}

const text = readFileSync(pkgPath, 'utf8')
const found = /"version"\s*:\s*"([^"]+)"/.exec(text)
if (found === null) {
  log('No version field in package.json - leaving it alone.')
  process.exit(0)
}
const local = found[1]

const parse = (value) =>
  value
    .split(/[.\-+]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
const compare = (a, b) => {
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

const order = compare(local, released)
if (order > 0) {
  log(`${local} is already ahead of the released ${released} - leaving it.`)
  process.exit(0)
}
if (order < 0) {
  log(`${local} is BEHIND the released ${released} - that needs a human, leaving it.`)
  process.exit(0)
}

// Same version as the release: only bump when the tree actually moved past that tag,
// otherwise a fresh clone would drift upward on every build for no reason.
let ahead = 0
try {
  ahead = Number.parseInt(git(['rev-list', '--count', `v${released}..HEAD`]), 10) || 0
} catch {
  ahead = 0
}
// Tracked changes only: the repo carries deliberately untracked scratch files, and
// those must never count as "work has happened".
const dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0
if (ahead === 0 && !dirty) {
  log(`Nothing has changed since v${released} - leaving the version at ${local}.`)
  process.exit(0)
}

const next = `${parse(local)[0]}.${parse(local)[1]}.${parse(local)[2] + 1}`
// Targeted replacement, not a re-serialise: rewriting the JSON would reformat the whole
// file and bury the one-character change in noise.
writeFileSync(pkgPath, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`))

log(`v${released} is published and the tree moved on: ${local} -> ${next}`)
log('Bumped once for this release. Later builds keep it until you tag the next one.')
