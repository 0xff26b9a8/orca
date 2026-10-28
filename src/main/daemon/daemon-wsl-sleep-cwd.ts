/** Bridge WSL bash lacks OSC 7; read its shell folder before Sleep so wake avoids the spawn folder. Failures retain the old fallback. */
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  readWslGuestPaneProcesses,
  readWslGuestPaneShellCwd
} from '../wsl/wsl-guest-pane-processes'
import { teardownReadBudgetMs } from './daemon-request-deadline'

// Reserve teardown time for the final checkpoint and kill when a distro does not answer.
const READ_BUDGET_MS = 3_000

/** The shell's folder in the bridge's UNC spelling, which wake reads; else null. */
export async function readDaemonWslSleepCwd(
  pane: { paneKey: string; wslDistro: string; live: boolean },
  deadlineMs?: number,
  capMs = READ_BUDGET_MS
): Promise<string | null> {
  const budget = teardownReadBudgetMs(capMs, deadlineMs)
  if (process.platform !== 'win32' || budget <= 0) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const rows = await Promise.race([
      readWslGuestPaneProcesses(pane.wslDistro, budget, { running: pane.live }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget)
        timer.unref?.()
      })
    ])
    const cwd = rows ? readWslGuestPaneShellCwd(rows, pane.paneKey) : null
    return cwd && /^\/(?!\/)/.test(cwd) ? toWindowsWslUncPath(cwd, pane.wslDistro) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Quit's once-only read of live bridge panes' folders, in parallel within one budget; a distro read is shared. */
export async function readDaemonWslQuitCwds(
  panes: readonly { sessionId: string; paneKey: string; wslDistro: string }[],
  budgetMs: number
): Promise<Map<string, string>> {
  const cwds = new Map<string, string>()
  await Promise.all(
    panes.map(async (pane) => {
      // `live` only skips a fresh running check when the running-distro cache already confirms it.
      const cwd = await readDaemonWslSleepCwd({ ...pane, live: true }, undefined, budgetMs)
      if (cwd) {
        cwds.set(pane.sessionId, cwd)
      }
    })
  )
  return cwds
}
