/**
 * TEMPORARY diagnostics for the 1.0.2 investigation.
 *
 * Dormant unless `%LOCALAPPDATA%\KokonaDSH\diag.on` exists, so it costs nothing in
 * a normal run. It exists because two reported bugs (the bottom bar's fill and the
 * open-in-app menu that grows and shrinks in a loop) can only be diagnosed from a
 * running page, and the shell has no DOM inspector.
 *
 * It samples the geometry, computed background and backdrop filter of a handful of
 * candidate surfaces four times a second and appends every change to
 * `%LOCALAPPDATA%\KokonaDSH\diag.log`, plus a sweep of anything in the lower third
 * whose class name looks like a panel. Read that file after reproducing a bug.
 *
 * Delete this file and its import in `index.ts` before releasing 1.0.2.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.env.LOCALAPPDATA ?? '.', 'KokonaDSH')
const FLAG = join(DIR, 'diag.on')
const LOG = join(DIR, 'diag.log')

let enabled = false
let started = 0
let buffer = ''

/** Append one timestamped line to the log (no-op unless the flag file exists). */
export function diagLine(message: string): void {
  if (!enabled) return
  buffer += `${Date.now() - started}ms ${message}\n`
}

function flush(): void {
  if (!buffer) return
  try {
    appendFileSync(LOG, buffer)
  } catch {
    /* a diagnostic must never take the window down */
  }
  buffer = ''
}

/** Surfaces worth watching: the bottom dock, its content wrappers, and any menu. */
const CANDIDATES = [
  '[class*="_bottomPanel"]',
  '[class*="_terminalWrap"]',
  '[class*="_browserBar"]',
  '[class*="_paneCard"]',
  '.xterm',
  '.xterm-viewport',
  '[data-dsh-better-sidebar]',
  '[data-sidebar-right-panel]',
  '[class*="_menuAnchor"]',
  '[class*="_split"]',
  '[class*="_list"]',
  '[class*="_portal"]',
  '[role="menu"]',
  '[class*="_itemWrap"]',
  '[class*="_item"]',
  '[data-trajectory-scroll]',
  '[class*="_table"]',
  '[class*="_details"]',
  '[class*="_toolbar"]'
]

function describe(element: Element): string {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const cls = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).join('.')
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').slice(0, 36)
  const backdrop = style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter')
  const inline = (element.getAttribute('style') ?? '').replace(/\s+/g, ' ').slice(0, 90)
  return (
    `${element.tagName.toLowerCase()}.${cls}` +
    ` @${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}` +
    ` bg=${style.backgroundColor} bf=${backdrop || 'none'} z=${style.zIndex}` +
    ` vis=${style.visibility} disp=${style.display} op=${style.opacity} kids=${element.childElementCount}` +
    ` inline="${inline}" "${text}"`
  )
}

/**
 * Stable identity per element. The first run keyed the change log by selector, so a
 * selector matching several nodes (every `_list`, every `_root`) made different
 * elements overwrite each other and look like one node changing shape.
 */
const ids = new WeakMap<Element, number>()
let nextId = 0
function idOf(element: Element): number {
  let id = ids.get(element)
  if (id === undefined) {
    id = nextId++
    ids.set(element, id)
  }
  return id
}

/** The children of a floating menu, which is where a width change would show up. */
function childrenOf(element: Element): string {
  const parts: string[] = []
  for (const child of Array.from(element.children).slice(0, 6)) {
    const rect = child.getBoundingClientRect()
    const cls = (child.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(-1)[0] ?? ''
    parts.push(`${cls || child.tagName.toLowerCase()}=${Math.round(rect.width)}x${Math.round(rect.height)}`)
  }
  return parts.join(' ')
}

/** Start sampling when the flag file is present. Safe to call once per page. */
export function installDiagnostics(): void {
  if (enabled) return
  if (!existsSync(FLAG)) return
  enabled = true
  started = Date.now()
  try {
    writeFileSync(LOG, `=== session ${new Date().toISOString()} platform=${process.platform} ===\n`)
  } catch {
    /* ignore */
  }
  const seen = new Map<string, string>()

  const record = (tag: string, key: string, value: string) => {
    if (seen.get(key) === value) return
    seen.set(key, value)
    diagLine(`[${tag}] ${key} -> ${value}`)
  }

  const sample = (tag: string) => {
    for (const selector of CANDIDATES) {
      const matches = document.querySelectorAll(selector)
      if (matches.length > 1) record(tag, `${selector} count`, String(matches.length))
      for (const element of matches) {
        const id = idOf(element)
        const value = `${describe(element)} children[${childrenOf(element)}]`
        record(tag, `${selector} #${id}`, value)
      }
    }
  }

  // Anything in the lower third whose class reads like a dock, in case the bar we
  // are hunting is neither better-sidebar's nor one of the fixed candidates.
  const sweep = () => {
    const limit = window.innerHeight * 0.55
    for (const element of document.querySelectorAll('[class]')) {
      const cls = element.getAttribute('class') ?? ''
      if (!/panel|bottom|terminal|dock|workbench|status|xterm/i.test(cls)) continue
      const rect = element.getBoundingClientRect()
      if (rect.height < 4 || rect.top < limit) continue
      record('sweep', `${cls} #${idOf(element)}`, describe(element))
    }
  }

  sample('boot')
  sweep()
  flush()

  let ticks = 0
  window.setInterval(() => {
    ticks += 1
    sample('tick')
    if (ticks % 4 === 0) sweep()
    flush()
  }, 300)
  window.addEventListener('beforeunload', flush)
}
