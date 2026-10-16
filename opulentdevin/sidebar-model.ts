import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Backend } from './backend'
import type { FolderId } from './zuse-runtime/packages/contracts/src/ids'
import type { Chat, Session } from './zuse-runtime/packages/contracts/src/session'

export type ChatArchiveFilter = 'active' | 'archived' | 'all'
export type ChatSidebarOptions = { backend: Backend | null; folderId: FolderId | null; archive?: ChatArchiveFilter; query?: string; onError?: (error: unknown) => void }

export function chatSidebarRows(rows: readonly Chat[], folderId: FolderId, archive: ChatArchiveFilter = 'active', query = ''): readonly Chat[] {
  const unique = new Map<Chat['id'], Chat>()
  for (const chat of rows) {
    if (chat.projectId !== folderId) continue
    const prior = unique.get(chat.id)
    if (!prior || chat.updatedAt.getTime() >= prior.updatedAt.getTime()) unique.set(chat.id, chat)
  }
  const needle = query.trim().toLocaleLowerCase()
  return [...unique.values()].filter(chat => (archive === 'all' || (archive === 'archived') === (chat.archivedAt !== null)) && (!needle || chat.title.toLocaleLowerCase().includes(needle))).sort((a, b) => (b.lastMessageAt ?? b.updatedAt).getTime() - (a.lastMessageAt ?? a.updatedAt).getTime() || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
}

export function sessionForChat(chat: Chat, sessions: readonly Session[]): Session | null {
  const candidates = sessions.filter(session => session.chatId === chat.id && session.projectId === chat.projectId && (chat.archivedAt !== null || session.archivedAt === null))
  const active = candidates.find(session => session.id === chat.activeSessionId)
  if (active) return active
  return [...candidates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))[0] ?? null
}

export function chatIsUnread(chat: Chat): boolean {
  return chat.lastMessageAt !== null && (chat.lastReadAt === null || chat.lastMessageAt.getTime() > chat.lastReadAt.getTime())
}

export class LatestSidebarRequest {
  private version = 0
  issue() { return ++this.version }
  current(version: number) { return version === this.version }
  invalidate() { this.version++ }
}

export function useChatSidebar({ backend, folderId, archive = 'active', query = '', onError }: ChatSidebarOptions) {
  const [catalogue, setCatalogue] = useState<{ backend: Backend | null; folderId: FolderId | null; rows: readonly Chat[] }>({ backend: null, folderId: null, rows: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const scope = useRef({ backend, folderId })
  const selection = useRef(new LatestSidebarRequest())
  const errorHandler = useRef(onError)
  errorHandler.current = onError
  if (scope.current.backend !== backend || scope.current.folderId !== folderId) { scope.current = { backend, folderId }; selection.current.invalidate() }
  const refresh = useCallback(() => setRefreshVersion(value => value + 1), [])

  useEffect(() => {
    let alive = true
    let revision = 0
    let loadingRevision = -1
    let running = false
    setCatalogue({ backend, folderId, rows: [] }); setError(null)
    if (!backend || !folderId) { setLoading(false); return }
    const report = (cause: unknown) => { if (alive) { setError(cause instanceof Error ? cause.message : String(cause)); errorHandler.current?.(cause) } }
    const reconcile = async () => {
      if (running || !alive) return
      running = true; setLoading(true)
      try {
        while (alive && loadingRevision !== revision) {
          const requestedRevision = revision
          loadingRevision = requestedRevision
          const rows = await backend.chats.list({ projectId: folderId, includeArchived: true })
          if (alive && revision === requestedRevision) { setCatalogue({ backend, folderId, rows: chatSidebarRows(rows, folderId, 'all') }); setError(null) }
        }
      } catch (cause) { report(cause) }
      finally { running = false; if (alive) setLoading(false) }
    }
    const invalidate = () => { revision++; void reconcile() }
    const subscription = backend.subscribe(backend.chats.changes({ projectId: folderId }), invalidate, report)
    invalidate()
    return () => { alive = false; selection.current.invalidate(); subscription.cancel() }
  }, [backend, folderId, refreshVersion])

  const chats = useMemo(() => folderId && catalogue.backend === backend && catalogue.folderId === folderId ? chatSidebarRows(catalogue.rows, folderId, archive, query) : [], [backend, folderId, catalogue, archive, query])
  const selectChat = useCallback(async (chat: Chat): Promise<Session | null> => {
    if (!backend || !folderId || chat.projectId !== folderId) throw new Error('Chat does not belong to the selected workspace.')
    const request = selection.current.issue()
    const current = () => selection.current.current(request) && scope.current.backend === backend && scope.current.folderId === folderId
    try {
      const authoritativeChat = await backend.run(backend.client['chat.get']({ chatId: chat.id }))
      if (!current()) throw new Error('Chat selection was superseded.')
      if (authoritativeChat.projectId !== folderId) throw new Error('Chat moved outside the selected workspace.')
      const sessions = await backend.sessions.list({ projectId: folderId, includeArchived: true })
      if (!current()) throw new Error('Chat selection was superseded.')
      const chosen = sessionForChat(authoritativeChat, sessions)
      if (!chosen) return null
      const fresh = await backend.sessions.get({ sessionId: chosen.id })
      if (!current()) throw new Error('Chat selection was superseded.')
      if (fresh.chatId !== authoritativeChat.id || fresh.projectId !== folderId || (authoritativeChat.archivedAt === null && fresh.archivedAt !== null)) throw new Error('The selected session changed. Select the chat again.')
      return fresh
    } catch (cause) {
      if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); errorHandler.current?.(cause); refresh() }
      throw cause
    }
  }, [backend, folderId, refresh])
  return { chats, loading, error, refresh, selectChat }
}
