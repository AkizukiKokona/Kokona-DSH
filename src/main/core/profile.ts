import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from '../exec'
import { createLogger } from '../logger'
import type { NodeRuntime } from '../node'
import { PACKED_MODULES_DIR, profileSeedDir } from '../paths'
import { buildCoreEnv } from './env'

const log = createLogger('profile')

export interface ProfileContext {
  node: NodeRuntime
  binPath: string
  cwd: string
  dshHome: string
  profile: string
  coreVersion: string
  presetPlugins: string[]
  onLine?: (line: string) => void
}

export function profileDir(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile)
}

function readProfileDeps(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return pkg.dependencies ?? {}
  } catch {
    return {}
  }
}

async function runDsh(ctx: ProfileContext, args: string[]): Promise<number | null> {
  const result = await exec(ctx.node.exe, [ctx.binPath, ...args], {
    cwd: ctx.cwd,
    env: buildCoreEnv(ctx.dshHome),
    windowsHide: true,
    onLine: (chunk) => ctx.onLine?.(chunk)
  })
  return result.code
}

/**
 * Lay down the profile that ships with the app.
 *
 * The bundled profile already carries every plugin and every transitive dependency, so a machine
 * that has installed nothing never has to reach a registry to get a working profile.
 *
 * Deliberately not used in safe mode: the shell passes an empty presetPlugins there, and a safe
 * profile must stay plugin-free or it cannot do the one job it exists for.
 */
function seedProfile(ctx: ProfileContext): boolean {
  if (ctx.presetPlugins.length === 0) return false
  const source = profileSeedDir()
  if (!existsSync(join(source, PACKED_MODULES_DIR))) return false
  const dir = profileDir(ctx.dshHome, ctx.profile)
  log.info(`seeding profile "${ctx.profile}" from the bundled copy`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(source, dir, { recursive: true })
  renameSync(join(dir, PACKED_MODULES_DIR), join(dir, 'node_modules'))
  return existsSync(join(dir, 'package.json'))
}

async function initProfile(ctx: ProfileContext): Promise<void> {
  const dir = profileDir(ctx.dshHome, ctx.profile)
  if (existsSync(join(dir, 'package.json'))) return
  if (seedProfile(ctx)) return
  log.info(`initializing profile "${ctx.profile}" from template "web"`)
  await runDsh(ctx, ['--profile', ctx.profile, '--from-default-profile', 'web', '--dump-config'])
  if (existsSync(join(dir, 'package.json'))) return

  log.warn('template init unavailable, writing a minimal profile by hand')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${ctx.profile}`,
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-base': ctx.coreVersion,
          '@deepseek-ai/dsh-web-app': ctx.coreVersion
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
            patchReload: 'live'
          }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n',
    'utf8'
  )
}

export async function ensureProfile(ctx: ProfileContext): Promise<void> {
  mkdirSync(join(ctx.dshHome, 'profiles'), { recursive: true })
  await initProfile(ctx)
  const dir = profileDir(ctx.dshHome, ctx.profile)
  const deps = readProfileDeps(dir)
  for (const plugin of ctx.presetPlugins) {
    if (deps[plugin]) continue
    log.info(`installing preset plugin "${plugin}"`)
    const code = await runDsh(ctx, ['plugin', '--profile', ctx.profile, 'add', plugin])
    if (code !== 0) log.warn(`preset plugin "${plugin}" failed to install (exit ${code})`)
  }
}
