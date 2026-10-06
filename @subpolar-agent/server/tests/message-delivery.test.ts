import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import {
  MessageDeliveryConflictError,
  messageDeliveryResponse,
  messageDeliveryState,
  reconcileRunningDeliveries,
  replayMessageDeliveryResponse,
  reserveMessageDelivery,
  withDeliveryMetadata,
} from '../persistence/message-delivery.ts'

describe('message delivery lifecycle', () => {
  it('reconciles running deliveries as interrupted without retrying them', () => {
    let queryText = ''
    let parameters: unknown[] = []
    const database = {
      query: (sql: string) => {
        queryText = sql
        return {
          run: (...values: unknown[]) => { parameters = values },
          get: () => null,
        }
      },
      transaction: <T>(callback: () => T) => () => callback(),
    }

    reconcileRunningDeliveries(database, 123)

    expect(queryText).toBe('UPDATE message_deliveries SET state = ?, updated_at = ? WHERE state = ?')
    expect(parameters).toEqual(['interrupted', 123, 'running'])
  })

  it('returns an explicit recoverable state for interrupted deliveries', () => {
    expect(messageDeliveryResponse({ messageId: 'message-1', state: 'interrupted' })).toEqual({
      ok: false,
      messageID: 'message-1',
      state: 'interrupted',
      error: {
        code: 'DELIVERY_INTERRUPTED',
        message: 'This delivery was interrupted before its outcome was known. It was not retried automatically. Resend the prompt to try again.',
        recoverable: true,
      },
    })
  })

  it('keeps native RPC fields when appending delivery metadata', () => {
    const response = withDeliveryMetadata(
      { type: 'response', id: 'rpc-1', success: true, data: { value: 1 } },
      messageDeliveryResponse({ messageId: 'message-1', state: 'completed' }),
    )

    expect(response).toMatchObject({
      type: 'response',
      id: 'rpc-1',
      success: true,
      data: { value: 1 },
      delivery: { messageID: 'message-1', state: 'completed', ok: true },
    })
  })

  it('replays the stored native response while preserving the legacy fallback', () => {
    const delivery = {
      ownerId: 'user-1', sessionId: 'session-1', messageId: 'message-1', content: 'hello', metadata: '{}',
      state: 'completed' as const, createdAt: 1, updatedAt: 2,
      replayResponse: { type: 'response', id: 'rpc-1', success: true, data: { value: 1 } },
    }

    expect(replayMessageDeliveryResponse(delivery)).toEqual({
      type: 'response', id: 'rpc-1', success: true, data: { value: 1 },
      delivery: { ok: true, messageID: 'message-1', state: 'completed' },
    })
    expect(replayMessageDeliveryResponse({
      ownerId: delivery.ownerId, sessionId: delivery.sessionId, messageId: delivery.messageId,
      content: delivery.content, metadata: delivery.metadata, state: delivery.state,
      createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
    })).toEqual(
      messageDeliveryResponse(delivery),
    )
  })

  it('rejects a same-ID mismatch instead of returning the first delivery', () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE message_deliveries (
        owner_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        content TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, response TEXT,
        PRIMARY KEY (owner_id, session_id, message_id)
      )
    `)

    const first = reserveMessageDelivery(database, 'user-1', 'session-1', 'message-1', 'first', { agent: 'master' })
    expect(first.created).toBe(true)
    expect(() => reserveMessageDelivery(database, 'user-1', 'session-1', 'message-1', 'second', { agent: 'master' }))
      .toThrow(MessageDeliveryConflictError)
    expect(database.query('SELECT content FROM message_deliveries WHERE message_id = ?').get('message-1')).toEqual({ content: 'first' })
    database.close()
  })

  it('atomically makes one winner for concurrent same-ID submissions', async () => {
    const database = new Database(':memory:')
    database.exec(`
      CREATE TABLE message_deliveries (
        owner_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        content TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, response TEXT,
        PRIMARY KEY (owner_id, session_id, message_id)
      )
    `)

    const results = await Promise.all(['first', 'second'].map(async (content) => {
      try {
        return { content, reservation: reserveMessageDelivery(database, 'user-1', 'session-1', 'message-1', content, {}) }
      } catch (error) {
        return { content, error }
      }
    }))

    expect(results.filter((result) => 'reservation' in result)).toHaveLength(1)
    expect(results.filter((result) => result.error instanceof MessageDeliveryConflictError)).toHaveLength(1)
    database.close()
  })

  it('does not normalize an interrupted state back to pending', () => {
    expect(messageDeliveryState('interrupted')).toBe('interrupted')
    expect(messageDeliveryState('unknown')).toBe('unknown')
  })
})
