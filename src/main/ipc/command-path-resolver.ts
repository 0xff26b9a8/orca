import { access, constants as fsConstants, readdir, stat } from 'node:fs/promises'
import { statSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type ResolveCommandOptions = {
  /** Defaults to `process.platform`. Lets tests exercise the win32 lookup on posix. */
  platform?: NodeJS.Platform
  /** Env whose PATH/PATHEXT to search. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** CWD used only for the win32 "search current directory first" rule. */
  cwd?: string
  /** Stop after this many matches; defaults to the complete list. */
  maxResults?: number
}

// Windows environment keys are case-insensitive even though this Record is not.
function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key]
  if (direct !== undefined) {
    return direct
  }
  const lowerKey = key.toLowerCase()
  for (const [envKey, value] of Object.entries(env)) {
    if (envKey.toLowerCase() === lowerKey) {
      return value
    }
  }
  return undefined
}

function getWindowsExtensions(env: NodeJS.ProcessEnv, command: string): string[] {
  const pathext = readEnvCaseInsensitive(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM'
  const extensions = pathext.split(';').filter((ext) => ext.length > 0)
  // Explicit extensions also permit exact-name matches alongside PATHEXT variants.
  if (command.includes('.')) {
    extensions.unshift('')
  }
  return extensions
}

type LocalCommandSelection = {
  scope: string
  selected?: { binary: string; stamp: string; cwd?: string }
}

const localCommandSelections = new Map<string, LocalCommandSelection>()

function selectionScope(options: ResolveCommandOptions): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const isWin = platform === 'win32'
  const pathValue = readEnvCaseInsensitive(env, 'PATH') ?? ''
  const pathApi = isWin ? path.win32 : path.posix
  const needsCwd = pathValue.split(isWin ? ';' : ':').some((dir) => !pathApi.isAbsolute(dir))
  return JSON.stringify([
    platform,
    pathValue,
    isWin ? readEnvCaseInsensitive(env, 'PATHEXT') : null,
    env.HOME,
    env.USERPROFILE,
    homedir(),
    needsCwd ? (options.cwd ?? process.cwd()) : null
  ])
}

function commandFileStamp(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode].join(':')
}

/** Publish only a successful version probe; a newer probe supersedes an older one. */
export function beginLocalCommandSelection(
  command: string
): (binary: string | null) => Promise<void> {
  if (command !== 'gh' && command !== 'glab') {
    return async () => {}
  }
  const scope = selectionScope({})
  const probeCwd = process.cwd()
  const previous = localCommandSelections.get(command)
  const selection: LocalCommandSelection = {
    scope,
    selected: previous?.scope === scope ? previous.selected : undefined
  }
  localCommandSelections.set(command, selection)
  return async (binary) => {
    if (localCommandSelections.get(command) !== selection) {
      return
    }
    if (binary === null || !path.isAbsolute(binary)) {
      delete selection.selected
      return
    }
    try {
      const stats = await stat(binary)
      if (localCommandSelections.get(command) === selection) {
        const cwd =
          process.platform === 'win32' &&
          path.win32.resolve(path.win32.dirname(binary)).toLowerCase() ===
            path.win32.resolve(probeCwd).toLowerCase()
            ? probeCwd
            : undefined
        // Only a current-directory CLI needs to stay tied to the probe's folder.
        selection.selected = stats.isFile()
          ? { binary, stamp: commandFileStamp(stats), cwd }
          : undefined
      }
    } catch {
      // A binary removed during the probe must not become the runtime selection.
      if (localCommandSelections.get(command) === selection) {
        delete selection.selected
      }
    }
  }
}

/** Native execution reuses preflight's selection without probing or replaying the operation. */
export function resolveSelectedLocalCommand(
  command: string,
  options: ResolveCommandOptions = {}
): string {
  const selection = localCommandSelections.get(command)
  if (!selection?.selected || selection.scope !== selectionScope(options)) {
    return command
  }
  if (
    selection.selected.cwd &&
    path.win32.resolve(options.cwd ?? process.cwd()).toLowerCase() !==
      path.win32.resolve(selection.selected.cwd).toLowerCase()
  ) {
    return command
  }
  try {
    const stats = statSync(selection.selected.binary)
    if (commandFileStamp(stats) === selection.selected.stamp) {
      return selection.selected.binary
    }
  } catch {
    // Missing or replaced binaries require a fresh version probe.
  }
  delete selection.selected
  return command
}

async function isExecutableFile(candidate: string, isWin: boolean): Promise<boolean> {
  try {
    // Follow symlinked CLIs to their real targets.
    const stats = await stat(candidate)
    if (stats.isDirectory()) {
      // PATH directories are not executable files despite their search bit.
      return false
    }
    if (isWin) {
      // Extension membership already enforced by the PATHEXT permutation.
      return stats.isFile()
    }
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Filesystem-only PATH lookup preserving the preflight absolute-path filter; use listLocalCommandPaths for shadowed candidates. */
export async function isCommandOnLocalPath(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<boolean> {
  return (await findLocalCommandPaths(command, options, true)).length > 0
}

/** Batched PATH lookup for detection: the subset of `commands` present on PATH.
 *  Reads each absolute PATH directory once instead of stat()ing every command-extension
 *  candidate (#34636); hits still go through `isExecutableFile`, so symlink, directory,
 *  permission and case semantics match `isCommandOnLocalPath`. */
export async function findCommandsOnLocalPath(
  commands: readonly string[],
  options: ResolveCommandOptions = {}
): Promise<Set<string>> {
  const found = new Set<string>()
  const bareCommands: string[] = []
  for (const command of commands) {
    if (!command) {
      continue
    }
    const isWin = (options.platform ?? process.platform) === 'win32'
    if (command.includes('/') || (isWin && command.includes('\\'))) {
      // Separator commands bypass PATH; keep their exact single-candidate semantics.
      if (await isCommandOnLocalPath(command, options)) {
        found.add(command)
      }
    } else {
      bareCommands.push(command)
    }
  }
  if (bareCommands.length === 0) {
    return found
  }

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const isWin = platform === 'win32'
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const delimiter = isWin ? ';' : ':'
  const pathDirs = (readEnvCaseInsensitive(env, 'PATH') ?? '').split(delimiter)
  const cwd = options.cwd ?? process.cwd()
  // The per-candidate lookup only ever checks absolute candidates, so relative
  // PATH entries (and a relative cwd) cannot produce matches here either.
  const searchDirs = [...new Set((isWin ? [cwd, ...pathDirs] : pathDirs).filter(isAbsolute))]

  const directoryListings = await Promise.all(
    searchDirs.map(async (dir) => {
      try {
        const names = await readdir(dir)
        return {
          dir,
          // Windows filesystems match case-insensitively; keep the on-disk spelling for stats.
          names: isWin
            ? new Map(names.map((name) => [name.toLowerCase(), name] as const))
            : new Set(names)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code === 'EACCES' || code === 'EPERM') {
          // A searchable-but-unreadable directory still admits stat on known names;
          // the per-candidate lookup found commands there, so probe them directly.
          return { dir, names: null }
        }
        // Missing or dangling directories hold no candidates; stat-per-candidate agreed.
        return null
      }
    })
  )

  for (const command of bareCommands) {
    const extensions = isWin ? getWindowsExtensions(env, command) : ['']
    // Deduplicate candidates per command: two commands (for example `tool` and
    // `tool.CMD`) may resolve to the same on-disk file, and each must still be found.
    const seenCandidates = new Set<string>()
    for (const listing of directoryListings) {
      if (!listing) {
        continue
      }
      for (const ext of extensions) {
        const wanted = command + ext
        const onDisk =
          listing.names === null
            ? wanted
            : isWin
              ? (listing.names as Map<string, string>).get(wanted.toLowerCase())
              : (listing.names as Set<string>).has(wanted)
                ? wanted
                : undefined
        if (onDisk === undefined) {
          continue
        }
        const candidate = path.posix.join(listing.dir, onDisk)
        const candidateKey = isWin ? candidate.toLowerCase() : candidate
        if (seenCandidates.has(candidateKey)) {
          continue
        }
        seenCandidates.add(candidateKey)
        if (await isExecutableFile(candidate, isWin)) {
          found.add(command)
          break
        }
      }
      if (found.has(command)) {
        break
      }
    }
  }
  return found
}

/** The absolute path `isCommandOnLocalPath` found, or null. */
export async function resolveCommandOnLocalPath(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<string | null> {
  return (await findLocalCommandPaths(command, options, true))[0] ?? null
}

/** Ordered, deduplicated candidates, including executable shims that may fail to run. */
export async function listLocalCommandPaths(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<string[]> {
  return findLocalCommandPaths(command, options, false)
}

async function findLocalCommandPaths(
  command: string,
  options: ResolveCommandOptions,
  stopAtFirst: boolean
): Promise<string[]> {
  if (!command) {
    return []
  }
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const isWin = platform === 'win32'
  // Use the requested platform's absolute-path rules, not the test host's.
  const isAbsolute = isWin ? path.win32.isAbsolute : path.posix.isAbsolute
  const delimiter = isWin ? ';' : ':'

  const hasPathSeparator = command.includes('/') || (isWin && command.includes('\\'))
  const pathDirs = (readEnvCaseInsensitive(env, 'PATH') ?? '').split(delimiter)
  // Separators bypass PATH; Windows searches cwd first.
  const searchDirs = hasPathSeparator ? [''] : isWin ? [cwd, ...pathDirs] : pathDirs
  const extensions = isWin ? getWindowsExtensions(env, command) : ['']

  const found: string[] = []
  const seen = new Set<string>()
  for (const dir of searchDirs) {
    for (const ext of extensions) {
      // Windows accepts forward slashes; POSIX joins keep synthetic Windows lookups testable everywhere.
      const candidate = path.posix.join(dir, command) + ext
      // Preserve the prior where/which absolute-resolution filter.
      const candidateKey = isWin ? candidate.toLowerCase() : candidate
      if (!isAbsolute(candidate) || seen.has(candidateKey)) {
        continue
      }
      seen.add(candidateKey)
      if (await isExecutableFile(candidate, isWin)) {
        found.push(candidate)
        if (stopAtFirst || found.length >= (options.maxResults ?? Infinity)) {
          return found
        }
      }
    }
  }
  return found
}
