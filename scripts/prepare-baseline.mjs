// Vendors everything the installer carries so a fresh install boots on a machine that has nothing:
// a core, a Node runtime, npm, pnpm, and a profile with the bundled plugins.
//
// All five are gitignored; together they are ~830 MB. Missing any one of them produces an
// installer that fails on a clean machine - which is what 1.1.0 shipped with.
//
// Run with a system Node; this is a build step, and CI runs it before electron-builder.
//
//   npm run prepare:baseline            # latest core
//   npm run prepare:baseline 0.1.7-rc.2 # a specific core version
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const resourcesDir = join(projectRoot, 'resources')

const DSH_PACKAGE = '@deepseek-ai/dsh'
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * The plugins the bundled profile ships with, pinned to the set that is known to work together.
 * `latest` is not good enough here: these plugins declare overlapping peers on the core's UI
 * packages, and resolving them freshly picks a combination the core then refuses to load.
 */
const PROFILE_PLUGINS = {
  'dsh-better-sidebar': '^0.21.1',
  'dsh-plugin-wallpaper-engine': '1.0.1',
  'dsh-whale-widget': '0.3.15',
  'dshmarket': '^1.65.1'
}

/** The loader bundles a profile mounts before any plugin. */
const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(PROFILE_PLUGINS)]

/**
 * electron-builder drops any `node_modules` sitting directly under an extraResources source, and
 * does it silently - the bundle looks complete and cannot boot. Every vendored tree therefore
 * keeps its modules under `packages` and the app renames them during the copy.
 */
const PACKED = 'packages'

function run(args, cwd) {
  execFileSync(npmCmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

function fresh(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function install(target, dependencies) {
  fresh(target)
  writeJson(join(target, 'package.json'), {
    name: 'kokona-dsh-bundle',
    version: '1.0.0',
    private: true,
    dependencies
  })
  run(['install', '--no-audit', '--no-fund', '--loglevel=error'], target)
}

// --- core -------------------------------------------------------------------------------------
const spec = process.argv[2] ?? 'latest'
const coreDir = join(resourcesDir, 'runtime-baseline')
console.log(`[core] installing ${DSH_PACKAGE}@${spec}`)
install(coreDir, { [DSH_PACKAGE]: spec })

const coreManifest = join(coreDir, 'node_modules', DSH_PACKAGE, 'package.json')
if (!existsSync(coreManifest)) throw new Error(`core install failed: ${coreManifest} missing`)
const coreVersion = JSON.parse(readFileSync(coreManifest, 'utf8')).version
renameSync(join(coreDir, 'node_modules'), join(coreDir, PACKED))
writeJson(join(coreDir, 'manifest.json'), { version: coreVersion, package: DSH_PACKAGE })
console.log(`[core] done: ${coreVersion}`)

// --- node -------------------------------------------------------------------------------------
// A real Node, not the app's Electron binary. Electron can impersonate Node via
// ELECTRON_RUN_AS_NODE, but the core's native addon fingerprints the runtime and supports only
// Electron 43+, while the app is on 38.
const nodeDir = join(resourcesDir, 'node')
console.log(`[node] copying ${process.execPath}`)
fresh(nodeDir)
const nodeRoot = dirname(process.execPath)
// node_modules is deliberately not copied. npm is vendored separately, and a node_modules sitting
// directly under an extraResources source is dropped by electron-builder without a word.
for (const entry of ['node.exe', 'node', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
  const from = join(nodeRoot, entry)
  if (existsSync(from)) cpSync(from, join(nodeDir, entry), { recursive: true })
}
console.log(`[node] done: ${process.version}`)

// --- npm --------------------------------------------------------------------------------------
// One level down under pkg/, because npm needs its own node_modules to be named that and
// electron-builder would drop it at the top of the source directory.
//
// The location differs by install: the Windows installer puts it beside node.exe, while the
// toolcache layout CI uses keeps it under lib/.
const npmDir = join(resourcesDir, 'npm')
const npmSource = [
  join(nodeRoot, 'node_modules', 'npm'),
  join(nodeRoot, 'lib', 'node_modules', 'npm'),
  join(nodeRoot, '..', 'lib', 'node_modules', 'npm')
].find((candidate) => existsSync(join(candidate, 'bin', 'npm-cli.js')))
if (npmSource === undefined) {
  console.log('[npm] skipped: no npm found beside this Node')
  rmSync(npmDir, { recursive: true, force: true })
} else {
  fresh(npmDir)
  cpSync(npmSource, join(npmDir, 'pkg'), { recursive: true })
  console.log(`[npm] done: ${JSON.parse(readFileSync(join(npmSource, 'package.json'), 'utf8')).version}`)
}

// --- pnpm -------------------------------------------------------------------------------------
// The core shells out to `pnpm` by bare name to install a profile's dependencies and ships none.
//
// Staged in its own directory: `fresh()` empties the destination, so installing straight into
// resources/pnpm would delete the tree being copied out of it.
const pnpmDir = join(resourcesDir, 'pnpm')
const pnpmStage = join(resourcesDir, '.pnpm-staging')
console.log('[pnpm] installing')
install(pnpmStage, { pnpm: 'latest' })
const pnpmSource = join(pnpmStage, 'node_modules', 'pnpm')
const pnpmPkg = existsSync(join(pnpmSource, 'package.json'))
  ? JSON.parse(readFileSync(join(pnpmSource, 'package.json'), 'utf8'))
  : null
// The entry point moved between majors - a JS script in some releases, a platform binary in
// others - so read it from the package instead of guessing. shims.ts runs whatever this resolves to.
const pnpmBinField = typeof pnpmPkg?.bin === 'string' ? pnpmPkg.bin : pnpmPkg?.bin?.pnpm
const pnpmEntry = pnpmBinField ? join(pnpmSource, pnpmBinField) : null
if (pnpmEntry === null || !existsSync(pnpmEntry)) {
  throw new Error(`pnpm install failed: no entry point found in ${pnpmSource}`)
}
console.log(`[pnpm] entry: ${pnpmBinField}`)
fresh(pnpmDir)
cpSync(pnpmSource, pnpmDir, { recursive: true })
rmSync(pnpmStage, { recursive: true, force: true })
// The entry at its final location. The staged copy is gone by the time the profile install runs.
const pnpmInstalled = join(pnpmDir, pnpmBinField)
console.log(`[pnpm] done: ${pnpmPkg.version}`)

// --- profile ----------------------------------------------------------------------------------
// A prepared profile, so the app never has to install the plugins from a registry on a machine
// that has just been set up.
const seedDir = join(resourcesDir, 'profile-seed')
console.log('[profile] building the bundled profile')
fresh(seedDir)
writeJson(join(seedDir, 'package.json'), {
  name: 'dsh-profile-kokona',
  private: true,
  dependencies: PROFILE_PLUGINS,
  dsh: { profile: { bundles: PROFILE_BUNDLES, patchReload: 'live' } }
})
writeFileSync(
  join(seedDir, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n'
)
writeFileSync(
  join(seedDir, 'cordis.yml'),
  '# dsh profile root - an empty entry list. The tree is composed as patches:\n' +
    "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n" +
    '# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n'
)
// Only the entry KokonaHarness itself needs. Never ship a personal patch layer here: theme,
// provider and model choices belong to whoever installs the app.
writeFileSync(
  join(seedDir, 'cordis.patch.yml'),
  '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
    '# a top-level YAML array of loader patch entries (id-targeted config\n' +
    '# overrides, disables, and insert lists; `!!js` expressions allowed).\n' +
    '#\n' +
    '# Only the entry KokonaHarness itself needs is preset here; everything else is yours to set.\n' +
    '- id: better-sidebar\n' +
    '  name: dsh-better-sidebar\n' +
    '  config:\n' +
    '    titleBarScheme: preset\n' +
    '    titleBarPresetId: dsh-desktop\n' +
    '    titleBarCompat: true\n' +
    '    agentOpenTools: true\n'
)
// pnpm, not npm. The core installs a profile's dependencies with pnpm, these plugins declare
// overlapping peers on the core's UI packages, and npm refuses to resolve them at all.
execFileSync(pnpmInstalled, ['install', '--no-frozen-lockfile'], { cwd: seedDir, stdio: 'inherit' })
const firstPlugin = Object.keys(PROFILE_PLUGINS)[0]
if (!existsSync(join(seedDir, 'node_modules', firstPlugin))) {
  throw new Error(`profile install failed: ${join(seedDir, 'node_modules', firstPlugin)} missing`)
}

// pnpm writes absolute paths from this machine into these, and .bin holds shell shims that point
// at them. Both are wrong on anyone else's machine and pnpm rebuilds them on the next install.
for (const junk of ['.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin']) {
  rmSync(join(seedDir, 'node_modules', junk), { recursive: true, force: true })
}
renameSync(join(seedDir, 'node_modules'), join(seedDir, PACKED))
console.log(`[profile] done: ${Object.keys(PROFILE_PLUGINS).length} plugins`)

console.log('[baseline] all five trees ready; electron-builder picks them up from extraResources')
