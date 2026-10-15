/**
 * Builds the text one round is matched against: the claimed input batch plus
 * the tail of the session log, bounded so a long session cannot make the match
 * cost grow without limit.
 * @module dsh-oikonomia-eye/recall
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

/** Join the text blocks of one message body; non-text blocks contribute nothing. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * The text one durable event contributes. Every other event type carries no
 * text a shape vocabulary can match against; `SessionEventMap` is
 * merge-extensible, so that is the documented default arm rather than a closed
 * union.
 */
function eventText(event: SessionEvent): string {
  if (event.type === 'user/message') return textOf(event.data.content)
  if (event.type === 'assistant/message') return textOf(event.data.message.content)
  if (event.type === 'tool/call') return `${event.data.name} ${event.data.arguments}`
  return ''
}

/**
 * Recall the newest text of one session, newest first from the claimed batch
 * and backwards through the log, cut to the last `limit` characters.
 * @param events - the session's durable events in append order.
 * @param messages - the input batch the step claims, which is not in the log yet.
 * @param limit - largest number of characters the result may carry.
 * @returns the recalled text, oldest-first within the bound, or an empty string.
 */
export function recallText(events: readonly SessionEvent[], messages: readonly UserMessage[], limit: number): string {
  const newestFirst: string[] = []
  let length = 0
  const take = (piece: string): boolean => {
    if (piece === '') return false
    newestFirst.push(piece)
    length += piece.length
    return length >= limit
  }
  for (const message of messages) {
    if (take(textOf(message.content))) break
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (take(eventText(event))) break
  }
  newestFirst.reverse()
  return newestFirst.join('\n').slice(-limit)
}
