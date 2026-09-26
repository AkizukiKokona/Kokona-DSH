import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DSH_PACKAGE } from '../../shared/constants'
import { dshBinPath, versionDir } from '../paths'
import { createLogger } from '../logger'
import type { NodeRuntime } from '../node'
import { exec } from '../exec'

const log = createLogger('installer')

/**
 * npm, vendored beside the bundled Node.
 *
 * Under `pkg/` because electron-builder drops a `node_modules` that sits directly under an
 * extraResources source, and npm needs its own node_modules to be named that.
 */
function bundledNpmCli(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'npm')
    : join(app.getAppPath(), 'resources', 'npm')
  const candidate = join(root, 'pkg', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : null
}

function resolveNpmCli(node: NodeRuntime): string | null {
  const bundled = bundledNpmCli()
  if (bundled !== null) return bundled
  const adjacent = join(dirname(node.exe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(adjacent) ? adjacent : null
}

export interface InstallOptions {
  version: string
  node: NodeRuntime
  onLine?: (line: string) => void
}

export async function installCore({ version, node, onLine }: InstallOptions): Promise<void> {
  const finalDir = versionDir(version)
  const stagingDir = `${finalDir}.installing`
  log.info(`installing ${DSH_PACKAGE}@${version} into ${stagingDir}`)
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  writeFileSync(
    join(stagingDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `kokona-dsh-runtime-${version}`,
        version: '1.0.0',
        private: true,
        dependencies: { [DSH_PACKAGE]: version }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const npmCli = resolveNpmCli(node)
  const args = npmCli
    ? [npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=error']
    : ['install', '--no-audit', '--no-fund', '--loglevel=error']
  const command = npmCli ? node.exe : process.platform === 'win32' ? 'npm.cmd' : 'npm'

  const result = await exec(command, args, {
    cwd: stagingDir,
    shell: !npmCli && process.platform === 'win32',
    onLine: (chunk) => onLine?.(chunk)
  })
  if (result.code !== 0) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error(`npm install failed (exit ${result.code}): ${result.stderr.slice(-2000)}`)
  }
  const stagedBin = join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(stagedBin)) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error(`install finished but the dsh bin is missing in ${stagingDir}`)
  }

  rmSync(finalDir, { recursive: true, force: true })
  renameSync(stagingDir, finalDir)
  if (!existsSync(dshBinPath(version))) throw new Error(`atomic move failed for ${version}`)
  log.info(`installed ${DSH_PACKAGE}@${version}`)
}
