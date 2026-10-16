import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImageAttachment, emptyComposerInput, ComposerInput, resolveProviderModel } from './composer-controls'
import { saveTranscriptExclusive } from './session-management'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const temporary = async () => { const path = await mkdtemp(join(tmpdir(), 'native-controls-')); directories.push(path); return path }

describe('native composer and session boundaries', () => {
  it('uses only available catalogue models or an authoritative default', () => {
    const provider = { models: [{ id: 'preferred', label: 'Preferred', available: true, origin: 'curated' as const }, { id: 'chosen', label: 'Chosen', available: true, origin: 'curated' as const }], defaultModelId: 'preferred', aliases: {}, live: { status: 'ok' as const, authoritative: true, fetchedAt: null, error: null } }
    expect(resolveProviderModel(provider, 'default')).toBe('preferred')
    expect(resolveProviderModel(provider, 'chosen')).toBe('chosen')
    expect(resolveProviderModel({ ...provider, defaultModelId: 'absent' }, '')).toBe('')
    expect(resolveProviderModel({ ...provider, models: provider.models.map(model => ({ ...model, available: false })) }, 'chosen')).toBe('')
  })
  it('preserves rich input while updating text', () => {
    const input = emptyComposerInput()
    const changed = new ComposerInput({ ...input, text: 'Hello', fileRefs: [{ relPath: 'a.ts', absPath: '/project/a.ts', kind: 'file' }] })
    expect(changed.text).toBe('Hello')
    expect(changed.fileRefs).toHaveLength(1)
    expect(changed.annotations).toEqual([])
  })
  it('exports only to an explicit new absolute Markdown path', async () => {
    const path = join(await temporary(), 'transcript.md')
    await saveTranscriptExclusive(path, '# Real transcript\n')
    expect(await readFile(path, 'utf8')).toBe('# Real transcript\n')
    await expect(saveTranscriptExclusive(path, 'overwrite')).rejects.toThrow()
    await expect(saveTranscriptExclusive('relative.md', 'text')).rejects.toThrow()
    await expect(saveTranscriptExclusive(path.replace('.md', '.txt'), 'text')).rejects.toThrow()
  })
  it('validates image paths and signatures before reading upload bytes', async () => {
    const dir = await temporary()
    const path = join(dir, 'fixture.png')
    await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    const image = await readImageAttachment(path)
    expect(image.mimeType).toBe('image/png')
    expect(image.originalName).toBe('fixture.png')
    expect(image.bytes.length).toBeGreaterThan(8)
    await writeFile(join(dir, 'not-an-image.png'), 'plain text')
    await expect(readImageAttachment(join(dir, 'not-an-image.png'))).rejects.toThrow('contents')
    await expect(readImageAttachment('relative.png')).rejects.toThrow('absolute')
    await expect(readImageAttachment(join(dir, 'secret.txt'))).rejects.toThrow('PNG')
  })
})
