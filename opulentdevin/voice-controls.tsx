import { useEffect, useRef, useState } from 'react'
import type { Backend } from './backend'
import { inspectVoiceCapture, readVoiceFile, startVoiceRecording, transcribeVoiceAudio, type VoiceAudio, type VoiceCaptureStatus, type VoiceRecording } from './voice-host'
import { SettingsCard as Card, SettingsNote as Note, SettingsAction as Action, SettingsField as Field, ConfirmAction, useSettingsAction } from './settings-controls'

export function VoiceControls({ backend, onError, onTranscript }: { backend: Backend; onError: (error: unknown) => void; onTranscript?: (text: string) => void }) {
  const [devices, setDevices] = useState<VoiceCaptureStatus | null>(null)
  const [selected, setSelected] = useState('')
  const [path, setPath] = useState('')
  const [recording, setRecording] = useState(false)
  const [audio, setAudio] = useState<VoiceAudio | null>(null)
  const [transcript, setTranscript] = useState('')
  const currentAudio = useRef<VoiceAudio | null>(null)
  const active = useRef<VoiceRecording | null>(null)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const { busy, message, run } = useSettingsAction(onError)
  const discard = () => { currentAudio.current?.bytes.fill(0); currentAudio.current = null; setAudio(null) }
  useEffect(() => { setDevices(null); setSelected(''); setTranscript(''); setAudio(null); setRecording(false); return () => { generation.current++; controller.current?.abort(); void active.current?.cancel(); currentAudio.current?.bytes.fill(0); currentAudio.current = null } }, [backend])
  const start = async () => {
    if (active.current || recording) return
    discard(); const epoch = generation.current; const abort = new AbortController(); controller.current = abort
    const capture = await startVoiceRecording({ microphoneId: selected, recordingConfirmed: true, signal: abort.signal })
    if (epoch !== generation.current || abort.signal.aborted) { await capture.cancel(); return }
    active.current = capture; setRecording(true)
    void capture.done.then(result => { if (epoch !== generation.current || abort.signal.aborted) { result.bytes.fill(0); return }; currentAudio.current = result; setAudio(result) }).catch(() => { if (epoch === generation.current && !abort.signal.aborted) onError(new Error('Recording failed. No audio was uploaded.')) }).finally(() => { if (active.current === capture) active.current = null; if (epoch === generation.current) setRecording(false) })
  }
  return <Card title="Voice recording and audio transcription">
    <Note>Recording and uploading are separate permissions. Nothing is captured or uploaded when this panel opens. Audio stays in memory until upload/discard; validation uses a private temporary file removed immediately afterwards.</Note>
    <Action label="Inspect microphones" disabled={busy || recording} onClick={() => { const epoch = generation.current; void run('Inspect microphones', async () => { const result = await inspectVoiceCapture(); if (epoch === generation.current) { setDevices(result); setSelected('') } }) }} />
    {devices && <Note warning={!devices.available}>{devices.reason}</Note>}
    {devices?.microphones.map(mic => <Action key={mic.id} label={`Microphone ${mic.label}`} selected={selected === mic.id} disabled={busy || recording} onClick={() => setSelected(mic.id)} />)}
    <ConfirmAction key={selected} label="Allow and start recording" detail="Allow this app to record the selected microphone now, for up to 150 seconds? This does not upload audio." disabled={busy || recording || !selected || !devices?.available} action={() => { void run('Start recording', start) }} />
    {recording && <><Note warning>Microphone recording is active. Stop to review metadata or cancel to discard.</Note><Action label="Stop recording" onClick={() => { void active.current?.stop().catch(() => {}) }} /><Action label="Cancel and discard recording" onClick={() => { controller.current?.abort(); void active.current?.cancel(); discard() }} /></>}
    <Field label="Existing local audio file absolute path" value={path} onChange={setPath} disabled={busy || recording} />
    <Action label="Validate selected audio file" disabled={busy || recording || !path} onClick={() => { const epoch = generation.current; void run('Validate audio file', async () => { const result = await readVoiceFile(path); if (epoch !== generation.current) { result.bytes.fill(0); return }; discard(); currentAudio.current = result; setAudio(result) }) }} />
    {audio && <><Note>{audio.mimeType} · {Math.ceil(audio.durationMs / 1000)} seconds · {audio.bytes.byteLength} bytes ready. No upload yet.</Note><ConfirmAction label="Upload audio for transcription" detail="Send this audio to the connected backend’s transcription service? It may contain private speech. The audio buffer is cleared after the request." disabled={busy || recording} action={() => { const epoch = generation.current; void run('Transcribe audio', async () => { try { const text = await transcribeVoiceAudio(backend, audio, true); if (epoch === generation.current) setTranscript(text) } finally { if (epoch === generation.current) discard() } }) }} /><Action label="Discard prepared audio" disabled={busy} onClick={discard} /></>}
    {transcript && <><textarea testId="voice-transcript" readOnly value={transcript} minRows={3} />{onTranscript && <Action label="Insert transcript into composer" onClick={() => onTranscript(transcript)} />}<Action label="Clear transcript" onClick={() => setTranscript('')} /></>}
    {message && <Note>{message}</Note>}
  </Card>
}
