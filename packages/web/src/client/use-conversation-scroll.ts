/** Conversation scroll position across streaming updates and unavailable recall metadata. */
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { UIEvent } from 'react'
import type { WorkspaceEventId, WorkspaceTurnProjection } from './contracts.ts'

/**
 * @param ready Whether validated metadata permits rendering the messages.
 * @param lastMessageId Last durable message in the selected room.
 * @param liveTurns Current transient conversation turns.
 * @returns Message container, scroll handler, and explicit controls for following the latest reply.
 */
export function useConversationScroll({ ready, lastMessageId, liveTurns }: {
  readonly ready: boolean
  readonly lastMessageId: WorkspaceEventId | undefined
  readonly liveTurns: readonly WorkspaceTurnProjection[]
}) {
  const messagesRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const readingPosition = useRef(0)

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    if (!ready) return
    const target = event.currentTarget
    readingPosition.current = target.scrollTop
    following.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48
  }, [ready])

  const pauseFollowing = useCallback((): void => {
    following.current = false
    if (ready && messagesRef.current !== null) readingPosition.current = messagesRef.current.scrollTop
  }, [ready])

  const followLatest = useCallback((): void => {
    following.current = true
    if (!ready || messagesRef.current === null) return
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    readingPosition.current = messagesRef.current.scrollTop
  }, [ready])

  useLayoutEffect(() => {
    const messages = messagesRef.current
    if (!ready || messages === null) return
    messages.scrollTop = following.current ? messages.scrollHeight : readingPosition.current
    readingPosition.current = messages.scrollTop
  }, [ready, lastMessageId, liveTurns])

  return { messagesRef, onScroll, pauseFollowing, followLatest }
}
