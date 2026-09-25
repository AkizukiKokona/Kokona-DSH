import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import { profileDir } from './profile'

const log = createLogger('recovery')

const CORE_PACKAGE_PREFIX = '@deepseek-ai/'
const TAIL_LINES = 200

/** Cordis logs a failed entry as `<id> (<package>): <error>`. */
const ENTRY_ERROR = /^([^\s(]+)\s+\(([^)]+)\):\s*(.+)$/
const ERROR_HINT =
  /error|exception|cannot find module|is not a function|is not defined|undefined|null|failed|ERR_|EADDRINUSE|ENOENT/i

export interface PluginFailure {
  id: string
  name: string
  detail: string
}

function tail(lines: string[]): string[] {
  return lines.length > TAIL_LINES ? lines.slice(lines.length - TAIL_LINES) : lines
}

function isCore(name: string): boolean {
  return name.includes(CORE_PACKAGE_PREFIX)
}

function pluginPackages(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return Object.keys(pkg.dependencies ?? {}).filter((name) => !isCore(name))
  } catch {
    return []
  }
}

/** Read the loader entry id a plugin bundle mounts itself under. */
function resolveEntryId(dir: string, pkg: string): string {
  try {
    const patch = readFileSync(join(dir, 'node_modules', pkg, 'cordis.patch.yml'), 'utf8')
    const match = /^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)/m.exec(patch)
    if (match) return match[1]
  } catch {
    // fall through to the package name
  }
  return pkg
}

/**
 * Look for a plugin that blew up during the failed boot. Tier one trusts the
 * cordis entry error shape, tier two falls back to a stack that mentions a
 * known plugin package. Core packages are never returned.
 */
export function detectPluginFailure(logLines: string[]): PluginFailure | null {
  const lines = tail(logLines)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = ENTRY_ERROR.exec(lines[index].trim())
    if (!match) continue
    const [, id, name, detail] = match
    if (isCore(name) || isCore(id)) continue
    if (!ERROR_HINT.test(detail)) continue
    return { id, name, detail: detail.slice(0, 200) }
  }
  return null
}

/** Same as {@link detectPluginFailure} but with the profile on disk so entry ids can be resolved. */
export function detectPluginFailureIn(profilePath: string, logLines: string[]): PluginFailure | null {
  const direct = detectPluginFailure(logLines)
  if (direct) return direct
  const lines = tail(logLines)
  for (const pkg of pluginPackages(profilePath)) {
    const mentioned = lines.some((line) => ERROR_HINT.test(line) && line.includes(pkg))
    if (!mentioned) continue
    const id = resolveEntryId(profilePath, pkg)
    const detail = lines.filter((line) => line.includes(pkg)).pop() ?? ''
    return { id, name: pkg, detail: detail.slice(0, 200) }
  }
  return null
}

function patchFile(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}

function alreadyDisabled(text: string, id: string): boolean {
  const blocks = text.split(/\n(?=- )/)
  return blocks.some((block) => {
    const idMatch = /^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)/m.exec(block)
    return idMatch?.[1] === id && /^\s*disabled:\s*true\s*$/m.test(block)
  })
}

/**
 * Append a `disabled: true` patch row for `id` to the profile's patch layer.
 * Idempotent; returns false when the plugin is already disabled.
 */
export function disablePlugin(profilePath: string, id: string): boolean {
  const file = patchFile(profilePath)
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '# KokonaHarness recovery layer\n'
  if (alreadyDisabled(text, id)) {
    log.info(`plugin "${id}" is already disabled`)
    return false
  }
  if (!text.endsWith('\n')) text += '\n'
  text += `- id: ${id}\n  disabled: true\n`
  writeFileSync(file, text, 'utf8')
  log.info(`disabled plugin "${id}" in ${file}`)
  return true
}

/** Undo an auto-disable so a plugin can be tried again. */
export function enablePlugin(profilePath: string, id: string): boolean {
  const file = patchFile(profilePath)
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  const blocks = text.split(/\n(?=- )/)
  const kept = blocks.filter((block) => {
    const idMatch = /^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)/m.exec(block)
    if (idMatch?.[1] !== id) return true
    return !/^\s*disabled:\s*true\s*$/m.test(block)
  })
  const next = kept.join('\n')
  if (next === text) return false
  writeFileSync(file, next, 'utf8')
  log.info(`re-enabled plugin "${id}" in ${file}`)
  return true
}

export function profilePath(dshHome: string, profile: string): string {
  return profileDir(dshHome, profile)
}
