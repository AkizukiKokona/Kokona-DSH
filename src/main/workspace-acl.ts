import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { exec } from './exec'

/**
 * Windows-only, best-effort preflight: make sure every known workspace grants
 * the current account WRITE_OWNER.
 *
 * Why this exists. Under `workspace-write`, the DSH ACL sandbox materializes
 * its confinement by writing three edits onto the workspace root in a single
 * SetNamedSecurityInfoW call: a capability-SID grant, an ambient-delete deny,
 * and a Low mandatory label. The label lives in the SACL, so that call needs
 * WRITE_OWNER — a right "Modify" does not carry, and one that ownership does
 * not supply either (an owner implicitly gets READ_CONTROL and WRITE_DAC only).
 * A drive that hands out Modify alone (D:\ ships
 * `Authenticated Users:(OI)(CI)(IO)(M)`) therefore fails the grant loudly: the
 * runner prints `windows-acl-run: <detail>` and exits 127, the seam classifies
 * that as a broken sandbox rather than a denial, and the confined command never
 * runs at all. The user-visible symptom is "workspace-write cannot modify
 * workspace files" — but only on drives that grant Modify; a workspace under
 * C:\Users\<user>\... already grants Full control and works untouched.
 *
 * The grant is the surgical minimum: WRITE_OWNER alone, inherited. It hands the
 * account no right it does not already hold over its own directories, it widens
 * nothing for any other principal, and it is exactly the edit the sandbox would
 * apply itself if the caller had the right. A workspace that already grants it
 * is skipped, so nothing is rewritten on every launch.
 *
 * The workspace registry (storages/workspace.json) is written when a workspace
 * is first opened — before any session can run a command in it — so watching it
 * fixes a workspace ahead of the first confined call rather than after.
 */

const TIMEOUT_MS = 20_000
const DEBOUNCE_MS = 1500

let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let cachedSid: string | null = null

interface WorkspaceRecord {
  path?: unknown
}

function workspacePaths(dshHome: string): string[] {
  const file = join(dshHome, 'storages', 'workspace.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      tables?: { workspaces?: Record<string, WorkspaceRecord> }
    }
    const table = parsed.tables?.workspaces
    if (!table || typeof table !== 'object') return []
    const paths = new Set<string>()
    for (const record of Object.values(table)) {
      if (record && typeof record.path === 'string' && record.path.trim()) paths.add(record.path)
    }
    return [...paths]
  } catch {
    return []
  }
}

async function currentUserSid(): Promise<string | null> {
  if (cachedSid) return cachedSid
  try {
    // Locale-proof: the CSV field is always the SID, whatever the display name.
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { timeout: TIMEOUT_MS })
    cachedSid = stdout.match(/"(S-\d-(?:\d+-)+\d+)"/)?.[1] ?? null
  } catch {
    cachedSid = null
  }
  return cachedSid
}

/**
 * Whether the ACL listing already grants WRITE_OWNER (or Full control) to the
 * account. icacls prints one ACE per line and the rights letters are not
 * localized; only the principal name is, and an account name is never
 * translated, so matching on `<domain>\<user>` is safe.
 */
function grantsWriteOwner(listing: string, account: string): boolean {
  for (const line of listing.split(/\r?\n/)) {
    if (!line.includes(account)) continue
    if (/\((?:F|WO)\)/.test(line)) return true
    if (/(?:^|[(,])\s*WO\s*(?:[,)]|$)/.test(line)) return true
  }
  return false
}

async function grantWriteOwner(dir: string, sid: string): Promise<string | null> {
  const { code, stderr } = await exec(
    'icacls',
    [dir, '/grant', `*${sid}:(OI)(CI)(WO)`, '/Q', '/C'],
    { timeout: TIMEOUT_MS }
  )
  if (code === 0) return null
  return (stderr.trim() || `icacls exited ${code ?? 'null'}`).split(/\r?\n/)[0]
}

export async function preflightWorkspaceAcls(
  dshHome: string,
  onLine: (line: string) => void
): Promise<void> {
  if (process.platform !== 'win32') return
  const dirs = workspacePaths(dshHome)
  if (!dirs.length) return
  const sid = await currentUserSid()
  if (!sid) return
  const account = `${process.env.USERDOMAIN ?? ''}\\${userInfo().username}`
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const listed = await exec('icacls', [dir], { timeout: TIMEOUT_MS })
      if (grantsWriteOwner(listed.stdout, account)) continue
      const failure = await grantWriteOwner(dir, sid)
      if (failure) onLine(`workspace acl: ${dir} still lacks WRITE_OWNER (${failure})`)
      else onLine(`workspace acl: granted WRITE_OWNER on ${dir}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onLine(`workspace acl: ${dir} check failed (${message})`)
    }
  }
}

/**
 * Run the preflight once and keep it current: the registry is rewritten as
 * workspaces come and go, so a debounced watch covers a workspace opened later
 * in the same run.
 */
export function startWorkspaceAclPreflight(
  dshHome: string,
  onLine: (line: string) => void
): void {
  if (process.platform !== 'win32' || watcher) return
  const run = (): void => {
    void preflightWorkspaceAcls(dshHome, onLine)
  }
  run()
  try {
    watcher = watch(join(dshHome, 'storages', 'workspace.json'), { persistent: false }, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(run, DEBOUNCE_MS)
    })
    watcher.on('error', () => {})
  } catch {
    // No registry yet: the first run already covered whatever exists, and the
    // next app start picks the file up.
    watcher = null
  }
}
