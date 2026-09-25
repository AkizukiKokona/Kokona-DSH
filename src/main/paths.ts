import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function configFile(): string {
  return join(userDataDir(), 'config.json')
}

export function logsDir(): string {
  return join(userDataDir(), 'logs')
}

export function runtimeRoot(): string {
  return join(userDataDir(), 'runtime')
}

export function versionDir(version: string): string {
  return join(runtimeRoot(), version)
}

export function activeFile(): string {
  return join(runtimeRoot(), 'active.json')
}

export function baselineDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'runtime-baseline')
  return join(app.getAppPath(), 'resources', 'runtime-baseline')
}

export function defaultDshHome(): string {
  return join(homedir(), '.dsh')
}

export function dshBinPath(version: string): string {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function iconPath(): string | undefined {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(candidate) ? candidate : undefined
}
