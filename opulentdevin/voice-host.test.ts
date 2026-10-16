import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import type { Backend } from './backend'
import { runVoiceProcess, inspectVoiceAudio, inspectVoiceCapture, parsePhysicalMicrophones, parseVoiceMetadata, readVoiceFile, startVoiceRecording, transcribeVoiceAudio, transcribeVoiceFile, type VoiceProcessRunner } from './voice-host'

const microphone = { name: 'alsa_input.usb-microphone', description: 'USB microphone', monitor_of_sink: null, properties: { 'device.class': 'sound', 'device.bus': 'usb', 'device.form_factor': 'microphone' } }
const metadata = (duration = '2', format = 'wav', streams = [{ codec_type: 'audio' }]) => JSON.stringify({ format: { duration, format_name: format }, streams })
const bytes = (value: string) => Buffer.from(value)
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.unstubAllEnvs(); vi.useRealTimers() })
const successRunner = (sources: unknown[] = [microphone]) => vi.fn<VoiceProcessRunner>((program, args) => ({ done: Promise.resolve(bytes(program === 'pactl' ? JSON.stringify(sources) : args.includes('-show_entries') ? metadata() : 'version')), stop: vi.fn(), cancel: vi.fn() }))
const fakeBackend = (result: { _tag: 'transcribed'; text: string } | { _tag: 'phoneFallbackRequired'; reason: 'blocked'; ticket: string } = { _tag: 'transcribed', text: 'hello' }) => {
  const transcribe = vi.fn((_payload: { bytes: Uint8Array; mimeType: string; durationMs: number }) => Effect.succeed(result))
  const backend = { client: { 'voice.transcribe': transcribe }, run: Effect.runPromise } as unknown as Pick<Backend, 'client' | 'run'>
  return { backend, transcribe }
}

describe('bounded native process wrapper', () => {
  const child = () => {
    const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null, kill: vi.fn(() => true) })
    vi.mocked(spawn).mockReturnValue(process as unknown as ReturnType<typeof spawn>)
    return process
  }
  it('uses argument arrays, ignores diagnostic output and clears intermediate audio', async () => {
    const process = child()
    const operation = runVoiceProcess('ffprobe', ['-version'], { maxBytes: 20, timeoutMs: 1000 })
    const chunk = bytes('sample'); process.stdout.emit('data', chunk); process.emit('close', 0)
    expect(Buffer.from(await operation.done).toString()).toBe('sample')
    expect([...chunk]).toEqual([0, 0, 0, 0, 0, 0])
    expect(spawn).toHaveBeenLastCalledWith('ffprobe', ['-version'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false })
  })
  it('kills on byte overflow and rejects rather than returning partial audio', async () => {
    const process = child()
    const operation = runVoiceProcess('ffmpeg', [], { maxBytes: 2, timeoutMs: 1000 })
    process.stdout.emit('data', bytes('oversize')); expect(process.kill).toHaveBeenCalledWith('SIGKILL'); process.emit('close', null)
    await expect(operation.done).rejects.toThrow('safety limit')
  })
  it('enforces the deadline and escalates a graceful stop', async () => {
    vi.useFakeTimers()
    const process = child()
    const operation = runVoiceProcess('ffmpeg', [], { maxBytes: 20, timeoutMs: 10000 })
    operation.stop(); expect(process.kill).toHaveBeenCalledWith('SIGINT')
    vi.advanceTimersByTime(3000); expect(process.kill).toHaveBeenCalledWith('SIGKILL'); process.emit('close', null)
    await expect(operation.done).rejects.toThrow('safety limit')
    const timed = child(); const pending = runVoiceProcess('pactl', [], { maxBytes: 20, timeoutMs: 100 })
    vi.advanceTimersByTime(100); expect(timed.kill).toHaveBeenCalledWith('SIGKILL'); timed.emit('close', null)
    await expect(pending.done).rejects.toThrow('safety limit')
  })
})

describe('voice host permission and device boundaries', () => {
  it('excludes monitor, virtual, line input and unknown sources', () => {
    expect(parsePhysicalMicrophones(JSON.stringify([microphone, { ...microphone, name: 'sink.monitor' }, { ...microphone, monitor_of_sink: 0 }, { ...microphone, properties: { 'device.class': 'sound' } }, { ...microphone, properties: { 'device.class': 'sound', 'device.bus': 'pci' } }]))).toEqual([{ id: microphone.name, label: microphone.description }])
  })
  it('reports monitor-only systems unavailable without recording or auth', async () => {
    const runner = successRunner([{ ...microphone, name: 'null.monitor' }])
    expect(await inspectVoiceCapture(runner, 'linux')).toMatchObject({ available: false, microphones: [] })
    expect(runner.mock.calls.map(([program, args]) => [program, args])).toEqual([['pactl', ['--format=json', 'list', 'sources']], ['ffmpeg', ['-version']], ['ffprobe', ['-version']]])
  })
  it('has no process calls on unsupported platforms or missing consent', async () => {
    const runner = successRunner()
    expect((await inspectVoiceCapture(runner, 'darwin')).available).toBe(false)
    await expect(startVoiceRecording({ microphoneId: microphone.name, recordingConfirmed: false }, runner, 'linux')).rejects.toThrow('permission')
    expect(runner).not.toHaveBeenCalled()
  })
  it('fails closed on invalid inventory or tools and rejects stale microphone ids', async () => {
    const failing = vi.fn<VoiceProcessRunner>(() => ({ done: Promise.reject(new Error('raw private path')), stop: vi.fn(), cancel: vi.fn() }))
    expect((await inspectVoiceCapture(failing, 'linux')).reason).not.toContain('raw private path')
    const runner = successRunner()
    await expect(startVoiceRecording({ microphoneId: 'unverified', recordingConfirmed: true }, runner, 'linux')).rejects.toThrow('unavailable')
    expect(runner.mock.calls.some(([, args]) => args.includes('pulse'))).toBe(false)
  })
})

describe('bounded audio validation and file upload', () => {
  it('validates known audio duration, container, streams and byte limits', () => {
    expect(parseVoiceMetadata(metadata(), 100)).toEqual({ mimeType: 'audio/wav', durationMs: 2000 })
    for (const raw of [metadata('NaN'), metadata('0'), metadata('151'), metadata('1', 'flac'), metadata('1', 'wav', [{ codec_type: 'video' }]), metadata('1', 'wav', [])]) expect(() => parseVoiceMetadata(raw, 100)).toThrow()
    for (const length of [0, 10 * 1024 * 1024 + 1]) expect(() => parseVoiceMetadata(metadata(), length)).toThrow()
  })
  it('probes a private seekable snapshot and deletes it after success', async () => {
    let probePath = ''
    const runner: VoiceProcessRunner = (program, args) => ({ done: (async () => {
      expect(program).toBe('ffprobe'); expect(args).toContain('file'); expect(args).toContain('-format_whitelist')
      probePath = args.at(-1)!
      expect((await stat(probePath)).mode & 0o777).toBe(0o600)
      expect((await readFile(probePath)).toString()).toBe('audio fixture')
      return bytes(metadata())
    })(), stop: vi.fn(), cancel: vi.fn() })
    expect((await inspectVoiceAudio(bytes('audio fixture'), runner)).durationMs).toBe(2000)
    await expect(access(probePath)).rejects.toThrow()
  })
  it('cleans the private snapshot on failed validation without exposing raw output', async () => {
    let probePath = ''
    const runner: VoiceProcessRunner = (_program, args) => { probePath = args.at(-1)!; return { done: Promise.resolve(bytes('private invalid response')), stop: vi.fn(), cancel: vi.fn() } }
    await expect(inspectVoiceAudio(bytes('fixture'), runner)).rejects.toThrow('validation failed')
    await expect(access(probePath)).rejects.toThrow()
  })
  it('rejects relative paths, directories and symlinks without probing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voice-test-')); directories.push(directory)
    const path = join(directory, 'audio.wav'); await writeFile(path, 'fixture'); await symlink(path, join(directory, 'link.wav'))
    const runner = successRunner()
    for (const path of ['relative.wav', directory, join(directory, 'link.wav')]) await expect(readVoiceFile(path, runner)).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
  })
  it('requires separate upload consent and sends actual file bytes with probed metadata', async () => {
    const { backend, transcribe } = fakeBackend(); const runner = successRunner()
    await expect(transcribeVoiceFile(backend, '/does-not-matter', false, runner)).rejects.toThrow('permission')
    expect(runner).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled()
    const directory = await mkdtemp(join(tmpdir(), 'voice-test-')); directories.push(directory)
    const path = join(directory, 'chosen.wav'); await writeFile(path, 'fixture')
    transcribe.mockImplementation(payload => { expect(payload).toMatchObject({ mimeType: 'audio/wav', durationMs: 2000 }); expect(Buffer.from(payload.bytes).toString()).toBe('fixture'); return Effect.succeed({ _tag: 'transcribed', text: 'hello' }) })
    expect(await transcribeVoiceFile(backend, path, true, runner)).toBe('hello')
    expect(await readFile(path, 'utf8')).toBe('fixture')
  })
  it('zeroes consumed audio and never returns fallback credentials or raw RPC errors', async () => {
    const { backend } = fakeBackend({ _tag: 'phoneFallbackRequired', reason: 'blocked', ticket: 'secret-ticket' })
    const audio = { bytes: bytes('fixture'), durationMs: 2000, mimeType: 'audio/wav' }
    await expect(transcribeVoiceAudio(backend, audio, true)).rejects.toThrow('fallback')
    expect([...audio.bytes].every(byte => byte === 0)).toBe(true)
  })
})

describe('explicit recording lifecycle without hardware', () => {
  it('aborts before or during microphone discovery without opening capture', async () => {
    const controller = new AbortController()
    const runner = successRunner()
    controller.abort()
    await expect(startVoiceRecording({ microphoneId: microphone.name, recordingConfirmed: true, signal: controller.signal }, runner, 'linux')).rejects.toThrow('cancelled')
    expect(runner).not.toHaveBeenCalled()
    const during = new AbortController()
    const base = runner.getMockImplementation()!
    runner.mockImplementation((program, args, options) => { during.abort(); return base(program, args, options) })
    await expect(startVoiceRecording({ microphoneId: microphone.name, recordingConfirmed: true, signal: during.signal }, runner, 'linux')).rejects.toThrow('cancelled')
    expect(runner.mock.calls.some(([, args]) => args.includes('pulse'))).toBe(false)
  })
  it('bounds recording and stops, validates and returns audio without upload', async () => {
    let resolveCapture: (bytes: Uint8Array) => void = () => {}
    const stop = vi.fn(() => resolveCapture(bytes('recording')))
    const runner = successRunner()
    const base = runner.getMockImplementation()!
    runner.mockImplementation((program, args, options) => {
      if (args.includes('pulse')) {
        expect(options).toEqual({ maxBytes: 10 * 1024 * 1024, timeoutMs: 160000 }); expect(args).toContain('150'); expect(args).toContain(microphone.name)
        return { done: new Promise(resolve => { resolveCapture = resolve }), stop, cancel: vi.fn() }
      }
      return base(program, args, options)
    })
    const capture = await startVoiceRecording({ microphoneId: microphone.name, recordingConfirmed: true }, runner, 'linux')
    expect(stop).not.toHaveBeenCalled()
    expect((await capture.stop()).mimeType).toBe('audio/wav'); expect(stop).toHaveBeenCalledOnce()
    await capture.cancel(); expect([...(await capture.done).bytes].every(byte => byte === 0)).toBe(true)
  })
  it('cancels in-flight capture without probing or returning audio', async () => {
    let rejectCapture: (error: Error) => void = () => {}
    const cancel = vi.fn(() => rejectCapture(new Error('cancelled')))
    const runner = successRunner(); const base = runner.getMockImplementation()!
    runner.mockImplementation((program, args, options) => args.includes('pulse') ? { done: new Promise((_resolve, reject) => { rejectCapture = reject }), stop: vi.fn(), cancel } : base(program, args, options))
    const capture = await startVoiceRecording({ microphoneId: microphone.name, recordingConfirmed: true }, runner, 'linux')
    await capture.cancel(); expect(cancel).toHaveBeenCalledOnce()
    expect(runner.mock.calls.some(([, args]) => args.includes('-show_entries'))).toBe(false)
  })
})
