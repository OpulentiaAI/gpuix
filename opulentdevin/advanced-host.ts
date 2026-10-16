import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export type NotificationCapability = { available: boolean; reason: string; executable?: string }
export async function notificationCapability(): Promise<NotificationCapability> {
  if (process.platform !== 'linux') return { available: false, reason: 'Native notification adapter is currently implemented for Linux only.' }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return { available: false, reason: 'No desktop session bus is available.' }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(value => value.startsWith('/'))) {
    const executable = join(directory, 'notify-send')
    try { await access(executable, constants.X_OK); return { available: true, reason: 'Linux desktop notification delivery is available; the desktop controls presentation.', executable } } catch {}
  }
  return { available: false, reason: 'Install the system libnotify notify-send utility to enable desktop notifications.' }
}
export function notificationArguments(title: string, body: string): string[] {
  if (!title.trim() || title.length > 160 || body.length > 2000 || /[\u0000-\u0008\u000b-\u001f]/.test(title + body)) throw new Error('Notification text exceeds the safe display bounds')
  return ['--app-name=OpulentDevin', '--', title, body]
}
export async function sendNativeNotification(title: string, body: string): Promise<void> {
  const capability = await notificationCapability()
  if (!capability.available || !capability.executable) throw new Error(capability.reason)
  await promisify(execFile)(capability.executable, notificationArguments(title, body), { timeout: 5000, maxBuffer: 16384 })
}
