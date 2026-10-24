import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { api } from '../sdk/client.ts'
import { errorMessage } from '../sdk/format.ts'
import { insertAt, quotePath } from './insert-path.ts'

const hasFiles = (event: { dataTransfer: DataTransfer | null }) =>
  event.dataTransfer?.types.includes('Files') ?? false

// Dropping a file anywhere else would navigate the tab away to it.
const keepTab = (event: globalThis.DragEvent) => {
  if (hasFiles(event)) event.preventDefault()
}

/** Drops files onto a composer: each is saved by the server and its quoted path inserted at the cursor. */
export function useFileDrop({
  conversation,
  textarea,
  text,
  update,
  setError,
  disabled,
}: {
  conversation: number | undefined
  textarea: () => HTMLTextAreaElement | null
  text: () => string
  update: (value: string) => void
  setError: (message: string | undefined) => void
  disabled: () => boolean
}) {
  const [over, setOver] = useState(false)
  const [uploading, setUploading] = useState(0)
  const depth = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    window.addEventListener('dragover', keepTab)
    window.addEventListener('drop', keepTab)
    return () => {
      alive.current = false
      window.removeEventListener('dragover', keepTab)
      window.removeEventListener('drop', keepTab)
    }
  }, [])

  async function drop(event: DragEvent) {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth.current = 0
    setOver(false)
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) return
    if (disabled()) {
      setError('Cannot upload files while the composer is disabled')
      return
    }
    setError(undefined)
    setUploading((count) => count + files.length)
    const settled: PromiseSettledResult<string>[] = []
    let pending = 0
    await Promise.all(
      Array.from({ length: Math.min(3, files.length) }, async () => {
        while (pending < files.length) {
          const index = pending++
          try {
            settled[index] = {
              status: 'fulfilled',
              value: await api.upload(conversation, files[index]),
            }
          } catch (reason) {
            settled[index] = { status: 'rejected', reason }
          }
        }
      }),
    )
    if (!alive.current) return
    setUploading((count) => count - files.length)
    const paths = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [quotePath(result.value)] : [],
    )
    const failed = settled.flatMap((result, index) =>
      result.status === 'rejected' ? [`${files[index].name}: ${errorMessage(result.reason)}`] : [],
    )
    if (failed.length) setError(failed.join('; '))
    if (!paths.length) return
    const input = textarea()
    const current = text()
    const start = input?.selectionStart ?? current.length
    const end = input?.selectionEnd ?? current.length
    const next = insertAt(current, start, end, paths.join(' '))
    update(next.text)
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  return {
    over,
    uploading: uploading > 0,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!hasFiles(event)) return
        depth.current++
        setOver(true)
      },
      onDragLeave: (event: DragEvent) => {
        if (!hasFiles(event)) return
        if (--depth.current <= 0) {
          depth.current = 0
          setOver(false)
        }
      },
      onDragOver: (event: DragEvent) => {
        if (hasFiles(event)) event.preventDefault()
      },
      onDrop: (event: DragEvent) => void drop(event),
    },
  }
}
