import { useCallback, useRef, useState } from 'react'
import { useGpuix, type PublicInstance } from '@gpuix/react'
import { Transcript, type TranscriptProps, type TranscriptRow } from './transcript'

export type TranscriptViewportProps = TranscriptProps & { loadOlder?: () => Promise<void>; loadingOlder?: boolean; hasOlder?: boolean }
export function listIsAtEnd(anchor: readonly number[] | null | undefined, rowCount: number): boolean {
  return rowCount === 0 || (anchor !== null && anchor !== undefined && anchor[0] === rowCount)
}

export function TranscriptViewport(props: TranscriptViewportProps) {
  return <TranscriptViewportScope key={JSON.stringify([props.environmentId, props.session?.id])} {...props} />
}
function TranscriptViewportScope(props: TranscriptViewportProps) {
  const renderRows = useCallback((rows: readonly TranscriptRow[]) => <VirtualTranscriptRows rows={rows} palette={props.palette} loadOlder={props.loadOlder} loadingOlder={props.loadingOlder} hasOlder={props.hasOlder} phase={props.timeline.phase} onError={props.onError} />, [props.palette, props.loadOlder, props.loadingOlder, props.hasOlder, props.timeline.phase, props.onError])
  return <Transcript {...props} renderRows={renderRows} />
}
export function VirtualTranscriptRows({ rows, palette: p, loadOlder, loadingOlder = false, hasOlder = false, phase, onError }: { rows: readonly TranscriptRow[]; palette: TranscriptProps['palette']; loadOlder?: () => Promise<void>; loadingOlder?: boolean; hasOlder?: boolean; phase: TranscriptProps['timeline']['phase']; onError: TranscriptProps['onError'] }) {
  const { renderer } = useGpuix()
  const list = useRef<PublicInstance>(null)
  const [following, setFollowing] = useState(true)
  const [requesting, setRequesting] = useState(false)
  const loading = useRef(false)
  const keys = useRef<readonly string[]>([])
  keys.current = rows.map(row => row.key)
  const latest = () => {
    if (!list.current || !renderer?.scrollToItem) { onError('Native list scrolling is unavailable.'); return }
    renderer.scrollToItem(list.current.id, rows.length)
    setFollowing(true)
  }
  const history = async () => {
    if (!loadOlder || !hasOlder || loading.current || loadingOlder || phase !== 'live') return
    loading.current = true; setRequesting(true); setFollowing(false)
    try {
      await loadOlder()
    } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
    finally { loading.current = false; setRequesting(false) }
  }
  const actionStyle = { padding: 6, borderRadius: 6, cursor: 'pointer' as const, backgroundColor: p.hover }
  return <div testId="transcript-viewport" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, width: '100%' }}>
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 36, flexShrink: 0, paddingLeft: 24, paddingRight: 24 }}>
      <div role="button" aria-label="Load older messages" aria-disabled={!hasOlder || loadingOlder || requesting || phase !== 'live'} tabIndex={hasOlder && !loadingOlder && !requesting && phase === 'live' ? 0 : -1} onClick={() => void history()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') void history() }} style={{ ...actionStyle, opacity: hasOlder ? 1 : 0.5 }}><text style={{ color: p.secondary, fontSize: 12 }}>{loadingOlder || requesting ? 'Loading history…' : hasOlder ? 'Load older messages' : 'Beginning of loaded history'}</text></div>
      <div role="button" aria-label="Jump to latest message" tabIndex={0} testId="transcript-jump-latest" onClick={latest} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') latest() }} style={actionStyle}><text style={{ color: p.secondary, fontSize: 12 }}>{following ? 'Latest' : 'Jump to latest'}</text></div>
    </div>
    <virtual-list ref={list} testId="transcript-virtual-list" role="log" aria-label="Session messages and pending interactions" alignment="bottom" followTail estimatedItemHeight={140} overdraw={512} onVisibleRange={() => { const anchor = list.current ? renderer?.getListScrollTop?.(list.current.id) : null; if (anchor) setFollowing(listIsAtEnd(anchor, keys.current.length)) }} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
      {rows.map(row => <div key={row.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', paddingTop: 6, paddingBottom: 6 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 740, paddingLeft: 24, paddingRight: 24 }}>{row.content}</div></div>)}
    </virtual-list>
  </div>
}
