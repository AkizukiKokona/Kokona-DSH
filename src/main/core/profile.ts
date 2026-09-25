import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from '../exec'
import { createLogger } from '../logger'
import { buildCoreEnv } from './env'

const log = createLogger('profile')

export interface ProfileContext {
  nodeExe: string
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
  const result = await exec(ctx.nodeExe, [ctx.binPath, ...args], {
    cwd: ctx.cwd,
    env: buildCoreEnv(ctx.dshHome),
    windowsHide: true,
    onLine: (chunk) => ctx.onLine?.(chunk)
  })
  return result.code
}

async function initProfile(ctx: ProfileContext): Promise<void> {
  const dir = profileDir(ctx.dshHome, ctx.profile)
  if (existsSync(join(dir, 'package.json'))) return
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
