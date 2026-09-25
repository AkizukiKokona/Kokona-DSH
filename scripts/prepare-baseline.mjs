import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const target = join(projectRoot, 'resources', 'runtime-baseline')
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
