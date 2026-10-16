import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const ZUSE_REVISION = 'ff7b4db6b15c8445c323ad39278905e951ecf13b'
export const ZUSE_REPOSITORY = 'https://github.com/Git-Godssoldier/zuse.git'

export function applicationRoot(moduleUrl = import.meta.url) {
  const directory = dirname(fileURLToPath(moduleUrl))
  return basename(directory) === 'dist' ? dirname(directory) : directory
}

export function resolveZuseRoot(moduleUrl = import.meta.url, configured = process.env.OPULENTDEVIN_ZUSE_DIR) {
  return configured ? resolve(configured) : resolve(applicationRoot(moduleUrl), '../../zuse')
}

export function verifyZuse(root: string) {
  if (!existsSync(join(root, 'package.json'))) throw new Error(`Zuse is absent at ${root}; run bun bootstrap-zuse.ts`)
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (revision !== ZUSE_REVISION) throw new Error(`Zuse revision ${revision} differs from required ${ZUSE_REVISION}; refusing to reset ${root}`)
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
  if (dirty) throw new Error(`Zuse has tracked changes at ${root}; refusing to use an unverified backend`)
  return root
}

export function bootstrapZuse(options: { root?: string; appRoot?: string; bun?: string; install?: boolean } = {}) {
  const root = options.root ?? resolveZuseRoot()
  const appRoot = options.appRoot ?? applicationRoot()
  if (!existsSync(root)) {
    mkdirSync(dirname(root), { recursive: true })
    execFileSync('git', ['clone', '--no-checkout', ZUSE_REPOSITORY, root], { stdio: 'inherit' })
    execFileSync('git', ['-C', root, 'checkout', '--detach', ZUSE_REVISION], { stdio: 'inherit' })
  }
  verifyZuse(root)
  if (options.install !== false) {
    execFileSync(options.bun ?? process.env.BUN_EXECUTABLE ?? 'bun', ['install', '--frozen-lockfile', '--filter', '@zusehq/server', '--filter', '@zuse/client-runtime', '--filter', '@zuse/ssh', '--ignore-scripts', '--linker', 'isolated'], { cwd: root, stdio: 'inherit' })
    execFileSync('npm', ['run', 'install', '--prefix', join(root, 'apps/server/node_modules/node-pty')], { stdio: 'inherit' })
  }
  const target = join(appRoot, 'zuse-runtime')
  if (existsSync(target)) {
    if (!lstatSync(target).isSymbolicLink() || realpathSync(target) !== realpathSync(root)) throw new Error(`Refusing to replace existing ${target}; remove or relocate it deliberately`)
  } else symlinkSync(root, target, 'junction')
  const manifest = JSON.parse(readFileSync(join(root, 'packages/client-runtime/package.json'), 'utf8'))
  if (manifest.name !== '@zuse/client-runtime') throw new Error('Unexpected Zuse client package')
  return root
}

if (process.argv[1] && basename(process.argv[1]) === 'bootstrap-zuse.ts' && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Pinned Zuse ready at ${bootstrapZuse()}`)
}
