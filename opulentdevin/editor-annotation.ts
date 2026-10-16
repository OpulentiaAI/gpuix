import type { EditorSelectionEvent } from '@gpuix/native/host'
import type { CodeAnnotation } from './zuse-runtime/packages/contracts/src/composer'

export type AnnotationSnapshot = { path: string; value: string; revision: number; startUTF16: number; endUTF16: number; selectedText: string }
function boundary(value: string, index: number) { return !(index > 0 && index < value.length && /[\uD800-\uDBFF]/.test(value[index - 1]) && /[\uDC00-\uDFFF]/.test(value[index])) }
export function captureAnnotation(path: string, value: string, selection: EditorSelectionEvent | null): AnnotationSnapshot {
  if (!selection || selection.composing) throw new Error('Select native editor text outside IME composition first.')
  const { selectionStart: start, selectionEnd: end, revision } = selection
  if (![start, end, revision].every(Number.isSafeInteger) || revision < 0 || start < 0 || end <= start || end > value.length || !boundary(value, start) || !boundary(value, end)) throw new Error('Native selection is empty or has invalid UTF-16 boundaries.')
  return { path, value, revision, startUTF16: start, endUTF16: end, selectedText: value.slice(start, end) }
}
export function confirmAnnotation(snapshot: AnnotationSnapshot, current: { path: string; value: string; selection: EditorSelectionEvent | null }, absPath: string, comment: string, id: string): CodeAnnotation {
  if (current.path !== snapshot.path || current.value !== snapshot.value || !current.selection || current.selection.composing || current.selection.revision !== snapshot.revision || current.selection.selectionStart !== snapshot.startUTF16 || current.selection.selectionEnd !== snapshot.endUTF16) throw new Error('Editor text or native selection changed. Select the region and annotate again.')
  if (!comment.trim()) throw new Error('Enter an annotation comment.')
  if (!absPath.startsWith('/')) throw new Error('An absolute workspace file path is required.')
  return { id, relPath: snapshot.path, absPath, startLine: snapshot.value.slice(0, snapshot.startUTF16).split('\n').length, endLine: snapshot.value.slice(0, snapshot.endUTF16 - 1).split('\n').length, comment: comment.trim() }
}
