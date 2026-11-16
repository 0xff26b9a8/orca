import { decodeOmpRewindTarget, encodeOmpRewindTarget } from '../../../shared/omp-rewind-target'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalRewindCut, JournalRewindSelection } from './journal-domain-rewind-cut'
import { rewindPosition } from './journal-domain-rewind-membership'

export function planOmpJournalRewindCut(
  scope: JournalSqlScope,
  target: JournalRewindSelection,
  selected: SqliteRow,
  floor: number
) {
  const turn = scope.db
    .prepare(`SELECT item_id,sequence,sequence_index,ordinal,provider_turn_id FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>?
        AND (item_id=? OR opener_item_id=?)
      ORDER BY sequence,sequence_index,ordinal LIMIT 1`)
    .get(...scope.prefix, floor, selected.turn_item_id ?? null, target.itemId)
  if (turn) {
    scope.examined(turn)
  }
  const providerItemId = String(selected.provider_item_id)
  const identity = parseAgentJournalItemKey(providerItemId)
  const beforeTurnId =
    identity?.provider === 'legacy' &&
    identity.agent === 'omp' &&
    identity.sessionId === target.nativeId
      ? encodeOmpRewindTarget({ entryId: identity.recordId })
      : turn?.provider_turn_id
  if (typeof beforeTurnId !== 'string' || !decodeOmpRewindTarget(beforeTurnId)) {
    return null
  }
  const selectedPosition = rewindPosition(selected)
  const turnPosition = turn && rewindPosition(turn)
  const boundary =
    turnPosition &&
    (turnPosition.sequence < selectedPosition.sequence ||
      (turnPosition.sequence === selectedPosition.sequence &&
        (turnPosition.sequenceIndex < selectedPosition.sequenceIndex ||
          (turnPosition.sequenceIndex === selectedPosition.sequenceIndex &&
            turnPosition.ordinal < selectedPosition.ordinal))))
      ? turnPosition
      : selectedPosition
  const cut: JournalRewindCut = { floor, providerItemId, beforeTurnId, keptTurnId: null }
  return {
    cut,
    membership: { floor, boundary, nativeId: target.nativeId, scopedTurns: true }
  }
}
