// Vendors the two build artifacts the installer ships: a baseline core and pnpm.
//
// Both are gitignored because together they are ~470 MB. Without them a freshly installed copy on
// a machine that has nothing - no Node, no npm, no pnpm, no core - cannot boot, which is exactly
// what 1.1.0 shipped with.
//
// Run with a system Node; this is a developer step, not something a user ever runs.
//
//   npm run prepare:baseline            # latest
//   npm run prepare:baseline 0.1.7-rc.2 # a specific version
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const resourcesDir = join(projectRoot, 'resources')
const target = join(resourcesDir, 'runtime-baseline')
const pnpmTarget = join(resourcesDir, 'pnpm')
const spec = process.argv[2] ?? 'latest'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, cwd) {
  execFileSync(npmCmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

console.log(`[baseline] target: ${target}`)
console.log(`[baseline] installing ${DSH_PACKAGE}@${spec}`)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
writeFileSync(
  join(target, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kokona-dsh-runtime-baseline',
      version: '1.0.0',
      private: true,
      dependencies: { [DSH_PACKAGE]: spec }
    },
    null,
    2
  )}\n`
)

run(['install', '--no-audit', '--no-fund', '--loglevel=error'], target)

const manifestPath = join(target, 'node_modules', DSH_PACKAGE, 'package.json')
if (!existsSync(manifestPath)) {
  throw new Error(`install failed: ${manifestPath} missing`)
}
const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version
writeFileSync(join(target, 'manifest.json'), `${JSON.stringify({ version, package: DSH_PACKAGE }, null, 2)}\n`)

console.log(`[baseline] done: core ${version}`)

// pnpm, so a profile install works on a machine that has no package manager of its own. The core
// shells out to `pnpm` by bare name and does not bundle one.
console.log(`[pnpm] target: ${pnpmTarget}`)
rmSync(pnpmTarget, { recursive: true, force: true })
mkdirSync(pnpmTarget, { recursive: true })
writeFileSync(
  join(pnpmTarget, 'package.json'),
  `${JSON.stringify(
    { name: 'kokona-bundled-pnpm', version: '1.0.0', private: true, dependencies: { pnpm: 'latest' } },
    null,
    2
  )}\n`
)
run(['install', '--no-audit', '--no-fund', '--loglevel=error'], pnpmTarget)

const pnpmRoot = join(pnpmTarget, 'node_modules', 'pnpm')
const pnpmEntry = join(pnpmRoot, 'bin', 'pnpm.cjs')
if (!existsSync(pnpmEntry)) {
  throw new Error(`install failed: ${pnpmEntry} missing`)
}
// Flatten it: extraResources copies resources/pnpm, and shims.ts looks for bin/pnpm.cjs there.
const pnpmVersion = JSON.parse(readFileSync(join(pnpmRoot, 'package.json'), 'utf8')).version
rmSync(pnpmTarget, { recursive: true, force: true })
mkdirSync(pnpmTarget, { recursive: true })
execFileSync(npmCmd, ['pack', 'pnpm@' + pnpmVersion, '--pack-destination', pnpmTarget], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
const tarball = join(pnpmTarget, `pnpm-${pnpmVersion}.tgz`)
execFileSync('tar', ['-xzf', tarball, '-C', pnpmTarget, '--strip-components=1'], { stdio: 'inherit' })
rmSync(tarball, { force: true })

console.log(`[pnpm] done: ${pnpmVersion}`)
console.log('[baseline] both artifacts ready; electron-builder picks them up from extraResources')
