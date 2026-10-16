import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_MANIFEST_SHA256 = 'eef51cea53f9d5b761d42f8c512fb0e4e158cd37b5a1e46d67b9eeb10071c783'
export const NATIVE_BINARY_SHA256 = '8042c2e162079286c522991fd51a17922e7f83774b5725f26849272ca913b694'
export const NATIVE_BASE_REVISION = '6a5c7c142ac32f9eb0caefe0121be995cfc18631'
export const NATIVE_GPUI_REVISION = 'c2e9f882030ca95cee55d206512a0a3ee6cd72b0'
export type NativeManifest = { base: string; gpui: string; files: { path: string; bytes: number; sha256: string }[] }
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
export function nativeAppRoot(moduleUrl = import.meta.url) {
  const directory = dirname(fileURLToPath(moduleUrl))
  return directory.endsWith(`${sep}dist`) ? dirname(directory) : directory
}
export function safeManifestPath(root: string, path: string) {
  const target = resolve(root, path)
  const inside = relative(realpathSync(root), realpathSync(target))
  if (isAbsolute(path) || !inside || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Native manifest path escapes delivery')
  if (!lstatSync(target).isFile()) throw new Error(`Native artifact is not a regular file: ${path}`)
  return target
}
export function verifyNativeDelivery(root: string): NativeManifest {
  if (hash(join(root, 'manifest.json')) !== NATIVE_MANIFEST_SHA256) throw new Error('Native delivery manifest is not the reviewed build manifest')
  const manifest: NativeManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  if (manifest.base !== NATIVE_BASE_REVISION || manifest.gpui !== NATIVE_GPUI_REVISION || !Array.isArray(manifest.files)) throw new Error('Native delivery has an unexpected source identity')
  for (const file of manifest.files) {
    const path = safeManifestPath(root, file.path)
    if (lstatSync(path).size !== file.bytes || hash(path) !== file.sha256) throw new Error(`Native artifact integrity failed: ${file.path}`)
  }
  if (hash(join(root, 'runtime/gpuix-native.linux-x64-gnu.node')) !== NATIVE_BINARY_SHA256) throw new Error('Native editor binary does not match the reviewed release')
  return manifest
}
export function installNativeDelivery(delivery: string, appRoot = nativeAppRoot()) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This verified native editor release is Linux x64 only; build the matching platform release first')
  const source = resolve(delivery)
  const manifest = verifyNativeDelivery(source)
  const destination = join(appRoot, '.native-runtime', 'releases', NATIVE_BINARY_SHA256)
  if (existsSync(destination)) { verifyNativeDelivery(destination); return destination }
  const stage = `${destination}.staging-${process.pid}`
  if (existsSync(stage)) throw new Error(`Incomplete native staging directory exists: ${stage}`)
  mkdirSync(stage, { recursive: true, mode: 0o700 })
  for (const file of manifest.files) {
    const target = join(stage, file.path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, file.path), target)
  }
  cpSync(join(source, 'manifest.json'), join(stage, 'manifest.json'))
  verifyNativeDelivery(stage)
  renameSync(stage, destination)
  return destination
}
export function activateNativeRuntime(appRoot = nativeAppRoot()) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Installed native editor runtime requires Linux x64')
  const runtime = join(appRoot, '.native-runtime', 'releases', NATIVE_BINARY_SHA256)
  if (!existsSync(runtime)) throw new Error('Native editor runtime is not installed. Run bun install-native.ts /absolute/path/to/verified-delivery before launching.')
  verifyNativeDelivery(runtime)
  const installed = join(appRoot, 'node_modules/@gpuix/native')
  const packageInfo = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  if (packageInfo.version !== '0.10.0') throw new Error('Native runtime requires the reviewed @gpuix/native 0.10.0 adapter contract')
  const source = join(runtime, 'runtime')
  for (const name of ['index.js', 'index.cjs', 'index.d.ts']) cpSync(join(source, name), join(installed, name))
  cpSync(join(source, 'dist'), join(installed, 'dist'), { recursive: true })
  const binary = join(source, 'gpuix-native.linux-x64-gnu.node')
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = binary
  return binary
}
if (process.argv[1] && basename(process.argv[1]) === 'install-native.ts' && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const delivery = process.argv[2]
  if (!delivery) throw new Error('Usage: bun install-native.ts /absolute/path/to/verified-delivery')
  console.log(`Verified native runtime installed: ${installNativeDelivery(delivery)}`)
}
