import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Backend } from './backend'
import { MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS } from './zuse-runtime/apps/server/src/voice/policy'

export type VoiceAudio = { bytes: Uint8Array; mimeType: string; durationMs: number }
export type VoiceProcessOptions = { input?: Uint8Array; maxBytes: number; timeoutMs: number }
export type VoiceProcess = { done: Promise<Uint8Array>; stop: () => void; cancel: () => void }
export type VoiceProcessRunner = (program: 'pactl' | 'ffmpeg' | 'ffprobe', args: readonly string[], options: VoiceProcessOptions) => VoiceProcess

export const runVoiceProcess: VoiceProcessRunner = (program, args, options) => {
  const child = spawn(program, [...args], { stdio: ['pipe', 'pipe', 'ignore'], shell: false })
  let stopped = false
  let cancelled = false
  let failed = false
  let size = 0
  const chunks: Buffer[] = []
  let grace: ReturnType<typeof setTimeout> | undefined
  const kill = () => { if (child.exitCode === null) child.kill('SIGKILL') }
  const deadline = setTimeout(() => { failed = true; kill() }, options.timeoutMs)
  const done = new Promise<Uint8Array>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > options.maxBytes) { chunk.fill(0); failed = true; kill(); return }
      chunks.push(chunk)
    })
    child.stdin.on('error', () => { failed = true; kill() })
    child.on('error', () => { failed = true })
    child.on('close', code => {
      clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      if (failed || cancelled || (code !== 0 && !(stopped && code === 255))) {
        for (const chunk of chunks) chunk.fill(0)
        reject(new Error(cancelled ? 'Voice operation cancelled.' : 'Voice host process failed or exceeded its safety limit.'))
        return
      }
      const bytes = Buffer.concat(chunks)
      for (const chunk of chunks) chunk.fill(0)
      resolve(bytes)
    })
  })
  void done.catch(() => {})
  child.stdin.end(options.input)
  return {
    done,
    stop: () => { if (stopped || child.exitCode !== null) return; stopped = true; child.kill('SIGINT'); grace = setTimeout(() => { failed = true; kill() }, 3000) },
    cancel: () => { cancelled = true; kill() },
  }
}

export type VoiceMicrophone = { id: string; label: string }
export type VoiceCaptureStatus = { available: boolean; microphones: VoiceMicrophone[]; reason: string }
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

export function parsePhysicalMicrophones(raw: string): VoiceMicrophone[] {
  const sources: unknown = JSON.parse(raw)
  if (!Array.isArray(sources)) throw new Error('Invalid audio-device inventory.')
  return sources.flatMap((source: unknown) => {
    const item = record(source)
    const properties = record(item?.properties)
    if (!item || !properties || typeof item.name !== 'string') return []
    const monitor = item.monitor_of_sink
    if (item.name.endsWith('.monitor') || (monitor !== null && monitor !== undefined && monitor !== 4294967295)) return []
    if (properties['device.class'] !== 'sound' || !['pci', 'usb', 'bluetooth'].includes(String(properties['device.bus']))) return []
    const activePort = typeof item.active_port === 'string' ? item.active_port : ''
    const ports: unknown[] = Array.isArray(item.ports) ? item.ports : []
    const microphonePort = ports.some(port => { const p = record(port); return p?.name === activePort && (p.type === 'mic' || /mic/i.test(String(p.name))) && p.availability !== 'not available' })
    const form = properties['device.form_factor']
    if (!microphonePort && form !== 'microphone' && form !== 'headset') return []
    return [{ id: item.name, label: typeof item.description === 'string' ? item.description : item.name }]
  })
}

export async function inspectVoiceCapture(runner: VoiceProcessRunner = runVoiceProcess, platform = process.platform): Promise<VoiceCaptureStatus> {
  if (platform !== 'linux') return { available: false, microphones: [], reason: 'Native recording is currently supported only by the Linux PulseAudio adapter. Choose an existing audio file instead.' }
  try {
    const result = await runner('pactl', ['--format=json', 'list', 'sources'], { maxBytes: 512 * 1024, timeoutMs: 5000 }).done
    const microphones = parsePhysicalMicrophones(Buffer.from(result).toString('utf8'))
    await runner('ffmpeg', ['-version'], { maxBytes: 64 * 1024, timeoutMs: 5000 }).done
    await runner('ffprobe', ['-version'], { maxBytes: 64 * 1024, timeoutMs: 5000 }).done
    return { available: microphones.length > 0, microphones, reason: microphones.length ? 'Choose a hardware microphone and explicitly allow recording. No audio has been captured.' : 'No identifiable hardware microphone is available. Monitor, virtual and unverified sources are excluded; choose an existing audio file instead.' }
  } catch { return { available: false, microphones: [], reason: 'Audio-device inspection or ffmpeg/ffprobe is unavailable. Check PulseAudio access and installed tools; no recording was started.' } }
}

export function parseVoiceMetadata(raw: string, byteLength: number): Omit<VoiceAudio, 'bytes'> {
  if (byteLength <= 0 || byteLength > MAX_VOICE_BYTES) throw new Error('Audio must contain at most 10 MiB and cannot be empty.')
  const value = record(JSON.parse(raw))
  const format = record(value?.format)
  const streams = value?.streams
  if (!Array.isArray(streams) || streams.length !== 1 || record(streams[0])?.codec_type !== 'audio') throw new Error('Choose a file containing one audio stream and no video.')
  const durationMs = Math.ceil(Number(format?.duration) * 1000)
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS) throw new Error('Audio duration must be known and between 0 and 150 seconds.')
  const formats = String(format?.format_name ?? '').split(',')
  const mimeType = formats.includes('wav') ? 'audio/wav' : formats.includes('mp3') ? 'audio/mpeg' : formats.includes('webm') ? 'audio/webm' : formats.includes('m4a') || formats.includes('mp4') ? 'audio/mp4' : null
  if (!mimeType) throw new Error('Unsupported audio container; choose WAV, MP3, WebM or MP4/M4A audio.')
  return { durationMs, mimeType }
}

export async function inspectVoiceAudio(bytes: Uint8Array, runner: VoiceProcessRunner = runVoiceProcess): Promise<VoiceAudio> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_VOICE_BYTES) throw new Error('Audio must contain at most 10 MiB and cannot be empty.')
  const directory = await mkdtemp(join(tmpdir(), 'native-voice-'))
  try {
    const path = join(directory, 'audio')
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    const result = await runner('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'wav,mp3,mov,matroska,webm', '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', '-i', path], { maxBytes: 64 * 1024, timeoutMs: 10000 }).done
    return { bytes, ...parseVoiceMetadata(Buffer.from(result).toString('utf8'), bytes.byteLength) }
  } catch { throw new Error('Audio validation failed. Use a supported single-stream audio file with a readable duration of at most 150 seconds and size of at most 10 MiB.') }
  finally { await rm(directory, { recursive: true, force: true }) }
}

export async function readVoiceFile(path: string, runner: VoiceProcessRunner = runVoiceProcess): Promise<VoiceAudio> {
  if (!isAbsolute(path)) throw new Error('Choose an absolute local audio-file path.')
  let bytes: Buffer | undefined
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size <= 0 || info.size > MAX_VOICE_BYTES) throw new Error('Invalid audio file.')
      bytes = Buffer.alloc(info.size + 1)
      let count = 0
      while (count < bytes.length) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead }
      const after = await file.stat()
      if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Audio file changed during inspection.')
      return await inspectVoiceAudio(bytes.subarray(0, count), runner)
    } finally { await file.close() }
  } catch { bytes?.fill(0); throw new Error('Unable to read a stable supported local audio file. Select a regular file, not a link, up to 10 MiB and 150 seconds.') }
}

export type VoiceRecording = { done: Promise<VoiceAudio>; stop: () => Promise<VoiceAudio>; cancel: () => Promise<void> }
export async function startVoiceRecording(input: { microphoneId: string; recordingConfirmed: boolean; signal?: AbortSignal }, runner: VoiceProcessRunner = runVoiceProcess, platform = process.platform): Promise<VoiceRecording> {
  if (!input.recordingConfirmed) throw new Error('Explicit microphone recording permission is required.')
  if (input.signal?.aborted) throw new Error('Recording cancelled.')
  const status = await inspectVoiceCapture(runner, platform)
  if (input.signal?.aborted) throw new Error('Recording cancelled.')
  if (!status.available || !status.microphones.some(mic => mic.id === input.microphoneId)) throw new Error('Selected hardware microphone is unavailable. Refresh the microphone inventory.')
  const capture = runner('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'pulse', '-i', input.microphoneId, '-t', '150', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBytes: MAX_VOICE_BYTES, timeoutMs: MAX_VOICE_DURATION_MS + 10000 })
  let cancelled = false
  let audio: VoiceAudio | undefined
  const done = capture.done.then(async bytes => {
    try {
      if (cancelled) throw new Error('Recording cancelled.')
      audio = await inspectVoiceAudio(bytes, runner)
      if (cancelled) throw new Error('Recording cancelled.')
      return audio
    } catch { bytes.fill(0); throw new Error('Recording cancelled or could not be validated. No audio was uploaded.') }
  })
  const abort = () => { cancelled = true; capture.cancel(); audio?.bytes.fill(0) }
  input.signal?.addEventListener('abort', abort, { once: true })
  void done.then(() => input.signal?.removeEventListener('abort', abort), () => input.signal?.removeEventListener('abort', abort))
  return { done, stop: () => { capture.stop(); return done }, cancel: async () => { abort(); try { await done } catch {} audio?.bytes.fill(0) } }
}

export async function transcribeVoiceAudio(backend: Pick<Backend, 'client' | 'run'>, audio: VoiceAudio, uploadConfirmed: boolean) {
  if (!uploadConfirmed) throw new Error('Explicit permission to upload audio for transcription is required.')
  try {
    if (audio.bytes.byteLength <= 0 || audio.bytes.byteLength > MAX_VOICE_BYTES || !Number.isFinite(audio.durationMs) || audio.durationMs <= 0 || audio.durationMs > MAX_VOICE_DURATION_MS || !/^audio\/(wav|mpeg|webm|mp4|m4a)$/.test(audio.mimeType)) throw new Error('Invalid audio payload.')
    const result = await backend.run(backend.client['voice.transcribe'](audio))
    if (result._tag !== 'transcribed') throw new Error('Phone authentication fallback is unavailable in the native host.')
    return result.text
  } catch { throw new Error('Transcription failed or requires phone fallback. No authentication ticket or raw service error was retained.') }
  finally { audio.bytes.fill(0) }
}

export async function transcribeVoiceFile(backend: Pick<Backend, 'client' | 'run'>, path: string, uploadConfirmed: boolean, runner: VoiceProcessRunner = runVoiceProcess) {
  if (!uploadConfirmed) throw new Error('Explicit permission to upload the selected audio file is required.')
  return transcribeVoiceAudio(backend, await readVoiceFile(path, runner), true)
}
