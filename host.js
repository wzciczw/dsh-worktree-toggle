/**
 * dsh-worktree-toggle — Host half.
 *
 * Three jobs:
 *
 *  1. `status` / `enable` back the composer switch: report the session's git
 *     facts and create a retained worktree through the harness's own
 *     `worktrees` service (the same service `create_worktree` uses).
 *  2. `enable` keeps its pre-flight to the minimum: one blank check, no extra
 *     git process before the real `git worktree add`.
 *  3. A background sweep removes worktrees of Session that have had no new
 *     event for `idleDays` days, freeing their disk space. It only touches
 *     linked worktrees under `<repo>/.agents/worktrees/` — the pool this plugin
 *     and the built-in tool create in — and never a worktree a live Session or
 *     a running Agent still uses.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Wire namespace: the browser calls `/api` endpoint `<namespace>/<method>`. */
const NAMESPACE = 'worktreeToggle'

/**
 * Marked on the class prototype under this key; the protocol package's
 * decorators write the same shape, but a plain-JS bundle cannot use decorators.
 */
const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Idle worktree cleanup policy. */
const GC = {
  /** Delete a worktree after this many days without a new Session event. */
  idleDays: 3,
  idleMs: 3 * 24 * 60 * 60 * 1000,
  /** Sweep cadence and the delay before the first sweep after mount. */
  intervalMs: 60 * 60 * 1000,
  initialDelayMs: 20 * 1000,
  /** Relative path (from the repository root) of the pool this plugin manages. */
  poolSegments: ['.agents', 'worktrees'],
  /** Observable state file under $DSH_HOME; best effort, never required. */
  statePath: join(homedir(), '.dsh', 'dsh-worktree-toggle', 'gc-state.json'),
  /** Records of the worktrees this plugin created: path plus Session id. */
  registryPath: join(homedir(), '.dsh', 'dsh-worktree-toggle', 'worktrees.json'),
  /**
   * Two-phase deletion: a candidate seen for the first time is only recorded;
   * the next sweep removes it if it is still idle. This keeps a freshly loaded
   * Host from deleting an old worktree before anyone can see the report.
   */
  requireSecondSweep: true,
}

/** Mark one public instance method as a direct Remote endpoint. */
function markRemote(prototype, method) {
  const current = Object.getOwnPropertyDescriptor(prototype, REMOTE_DESCRIPTOR)?.value
  const methods = Array.isArray(current?.methods) ? current.methods : []
  Object.defineProperty(prototype, REMOTE_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        ...methods,
        Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })
}

/** Run git with an argv array, a deadline and an output cap. */
function runGit(args, cwd, timeoutMs = 6000) {
  return new Promise((done) => {
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      })
    } catch (error) {
      done({ code: -1, out: '', err: String(error) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (out.length < 65536) out += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < 65536) err += chunk
    })
    child.on('error', (error) => finish({ code: -1, out, err: String(error) }))
    child.on('close', (code) => finish({ code: code ?? -1, out, err }))
  })
}

/** Compare two paths the way the platform does. */
function samePath(left, right) {
  if (left === null || right === null) return false
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** One `git rev-parse` for the checkout facts the UI needs. */
async function gitFacts(cwd) {
  const result = await runGit(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], cwd)
  if (result.code !== 0) return null
  const [top, gitDir, commonDir] = result.out.trim().split(/\r?\n/)
  if (top === undefined || gitDir === undefined || commonDir === undefined) return null
  const gitPath = resolve(cwd, gitDir)
  const commonPath = resolve(cwd, commonDir)
  return { root: top, commonDir: commonPath, worktree: !samePath(gitPath, commonPath) }
}

/** Whether a Session has produced no message or tool activity yet. */
function isBlank(session) {
  try {
    return !session.ownEvents().some((event) =>
      event.type === 'user/message'
      || event.type === 'assistant/message'
      || event.type === 'tool/call'
      || event.type === 'tool/result',
    )
  } catch {
    return false
  }
}

/** Normalize one path for set membership. */
function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** The service exposed to the browser half as namespace `worktreeToggle`. */
class WorktreeToggleService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, NAMESPACE)
    this.hostCtx = ctx
    /** Paths that looked idle on an earlier sweep; removed on the next one. */
    this.pending = new Map()
  }

  /** Effective directory of one session, without filesystem I/O. */
  cwdOf(session) {
    try {
      const directory = this.hostCtx.get('workingDirectory')
      const committed = directory?.get?.(session)
      if (typeof committed === 'string' && committed !== '') return committed
    } catch {}
    return typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
  }

  /** The git facts the switch needs, for one session. */
  async status(req) {
    const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : ''
    const sessions = this.hostCtx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (session === undefined) return { ok: false, reason: 'no-session' }

    const cwd = this.cwdOf(session)
    const blank = isBlank(session)
    if (typeof cwd !== 'string' || cwd === '') return { ok: true, value: { repo: false, blank } }

    const facts = await gitFacts(cwd)
    if (facts === null) return { ok: true, value: { repo: false, blank } }
    // Opening a Session that already lives in a managed worktree registers it,
    // so the idle sweep can retire worktrees this plugin did not create itself.
    this.adoptWorktree(cwd, sessionId, facts)
    return { ok: true, value: { repo: true, blank, worktree: facts.worktree, path: cwd } }
  }

  /** Create a new worktree for a session that has not started yet. */
  async enable(req, signal) {
    const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : ''
    const sessions = this.hostCtx.get('sessions')
    const agents = this.hostCtx.get('agents')
    const worktrees = this.hostCtx.get('worktrees')
    if (sessions === undefined || agents === undefined || worktrees === undefined) {
      return { ok: false, reason: 'unavailable' }
    }

    const session = sessions.get?.(sessionId)
    if (session === undefined) return { ok: false, reason: 'no-session' }
    if (!isBlank(session)) return { ok: false, reason: 'not-new' }

    const agent = agents.get?.(sessionId)
    if (agent === undefined) return { ok: false, reason: 'no-agent' }

    // No extra git process here: the real creation below is the expensive part.
    try {
      const created = await worktrees.create(agent, {}, signal)
      this.rememberWorktree(created.path, sessionId)
      return { ok: true, value: { path: created.path } }
    } catch (error) {
      return {
        ok: false,
        reason: 'create-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Repository root of a checkout, from its common git directory. */
  repoRootOf(facts) {
    return basename(facts.commonDir) === '.git' ? dirname(facts.commonDir) : facts.commonDir
  }

  /** Register a worktree seen in use when it sits in the managed pool. */
  adoptWorktree(path, sessionId, facts) {
    if (facts === null || facts === undefined || facts.worktree !== true) return
    if (!this.insideManagedPool(path, this.repoRootOf(facts))) return
    this.rememberWorktree(path, sessionId)
  }

  /** Worktree records this plugin created; the cleanup's primary inventory. */
  readRegistry() {
    try {
      const parsed = JSON.parse(readFileSync(GC.registryPath, 'utf8'))
      const entries = Array.isArray(parsed?.worktrees) ? parsed.worktrees : []
      return entries.filter((entry) => typeof entry?.path === 'string' && entry.path !== '')
    } catch {
      return []
    }
  }

  writeRegistry(worktrees) {
    try {
      mkdirSync(dirname(GC.registryPath), { recursive: true })
      writeFileSync(GC.registryPath, `${JSON.stringify({ worktrees }, null, 2)}\n`, 'utf8')
    } catch {}
  }

  /** Remember one created worktree so the sweep can retire it later. */
  rememberWorktree(path, sessionId) {
    if (typeof path !== 'string' || path === '') return
    const worktrees = this.readRegistry()
    const key = pathKey(path)
    if (worktrees.some((entry) => pathKey(entry.path) === key)) return
    worktrees.push({ path, sessionId, createdAt: Date.now() })
    this.writeRegistry(worktrees)
  }

  /**
   * Remove worktrees whose Session has been silent for `GC.idleDays` days.
   * Returns a small report and mirrors it into the state file.
   */
  async sweepIdleWorktrees() {
    const pending = (this.pending ??= new Map())
    const report = {
      at: Date.now(),
      engine: 'registry-v2',
      idleDays: GC.idleDays,
      scanned: 0,
      registry: 0,
      candidates: 0,
      removed: [],
      deferred: [],
      skipped: [],
    }
    const query = this.hostCtx.get('sessionQuery')
    if (query === undefined) {
      report.skipped.push({ reason: 'session-query-unavailable' })
      this.writeState(report)
      return report
    }

    let records = []
    try {
      records = await query.listSessions()
    } catch (error) {
      report.skipped.push({ reason: 'list-failed', message: messageOf(error) })
      this.writeState(report)
      return report
    }
    report.scanned = records.length

    // Two inventories feed the sweep: the worktrees this plugin created (with
    // their Session ids), and any Session whose own recorded directory is a
    // linked worktree. Live Sessions and running Agents are excluded below.
    const liveCwds = new Set()
    const liveIds = new Set()
    const liveByCwd = new Map()
    const sessions = this.hostCtx.get('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        if (session?.id !== undefined) liveIds.add(String(session.id))
        const cwd = this.cwdOf(session)
        if (typeof cwd !== 'string' || cwd === '') continue
        const key = pathKey(cwd)
        liveCwds.add(key)
        if (session?.id !== undefined) liveByCwd.set(key, { cwd, sessionId: String(session.id) })
      }
    }

    // A running Session sitting in a managed worktree is proof the worktree is
    // in use: register it now so it becomes eligible once the Session closes.
    for (const { cwd, sessionId } of liveByCwd.values()) {
      const facts = await gitFacts(cwd)
      this.adoptWorktree(cwd, sessionId, facts)
    }

    const byPath = new Map()
    const ensureEntry = (path) => {
      const key = pathKey(path)
      let entry = byPath.get(key)
      if (entry === undefined) {
        entry = { path, sessions: [], live: false, baseline: 0 }
        byPath.set(key, entry)
      }
      return entry
    }

    for (const record of records) {
      const cwd = record?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      const entry = ensureEntry(cwd)
      if (typeof record.header.id === 'string') entry.sessions.push(record.header.id)
      if (record.live === true) entry.live = true
    }

    const registry = this.readRegistry()
    report.registry = registry.length
    for (const item of registry) {
      const entry = ensureEntry(item.path)
      if (typeof item.sessionId === 'string' && item.sessionId !== '') entry.sessions.push(item.sessionId)
      if (typeof item.createdAt === 'number' && item.createdAt > entry.baseline) entry.baseline = item.createdAt
    }

    const stillIdle = new Set()
    const removedKeys = new Set()
    for (const [key, entry] of byPath) {
      if (entry.live || liveCwds.has(key)) continue
      if (entry.sessions.some((sessionId) => liveIds.has(String(sessionId)))) continue

      const facts = await gitFacts(entry.path)
      if (facts === null || !facts.worktree) continue
      const repoRoot = this.repoRootOf(facts)
      if (!this.insideManagedPool(entry.path, repoRoot)) {
        report.skipped.push({ path: entry.path, reason: 'outside-pool' })
        continue
      }
      report.candidates += 1

      let last = entry.baseline
      let known = entry.baseline > 0
      for (const sessionId of new Set(entry.sessions)) {
        try {
          const events = await query.listEvents(sessionId)
          if (Array.isArray(events) && events.length > 0) {
            known = true
            for (const event of events) {
              const time = typeof event?.time === 'number' ? event.time : 0
              if (time > last) last = time
            }
          }
        } catch {}
      }
      if (!known) {
        report.skipped.push({ path: entry.path, reason: 'no-activity-record' })
        continue
      }
      if (report.at - last < GC.idleMs) continue

      stillIdle.add(key)
      if (GC.requireSecondSweep && !pending.has(key)) {
        pending.set(key, { path: entry.path, sessions: entry.sessions, lastActivity: last })
        report.deferred.push({ path: entry.path, sessions: entry.sessions, lastActivity: last })
        continue
      }
      pending.delete(key)

      const removal = await runGit(['worktree', 'remove', '--force', entry.path], repoRoot, 30000)
      if (removal.code === 0) {
        removedKeys.add(key)
        report.removed.push({ path: entry.path, sessions: entry.sessions, lastActivity: last })
      } else {
        report.skipped.push({
          path: entry.path,
          reason: 'remove-failed',
          message: removal.err.trim().slice(0, 300),
        })
      }
    }

    for (const key of [...pending.keys()]) {
      if (!stillIdle.has(key)) pending.delete(key)
    }

    if (registry.length > 0) {
      const surviving = registry.filter((item) => !removedKeys.has(pathKey(item.path)) && existsSync(item.path))
      if (surviving.length !== registry.length) this.writeRegistry(surviving)
    }

    if (report.removed.length > 0) {
      console.log('[dsh-worktree-toggle] removed idle worktrees:', report.removed.map((item) => item.path))
    }
    this.writeState(report)
    return report
  }

  /** Whether one worktree path sits inside `<repo>/.agents/worktrees/`. */
  insideManagedPool(worktreePath, repoRoot) {
    const pool = resolve(repoRoot, ...GC.poolSegments)
    const prefix = pathKey(pool.endsWith(sep) ? pool : pool + sep)
    const target = pathKey(resolve(worktreePath).endsWith(sep) ? resolve(worktreePath) : resolve(worktreePath) + sep)
    return target.startsWith(prefix)
  }

  /** Mirror the last sweep for the user and for verification; never throws. */
  writeState(report) {
    try {
      mkdirSync(dirname(GC.statePath), { recursive: true })
      writeFileSync(GC.statePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch {}
  }
}

/** Best-effort message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

markRemote(WorktreeToggleService.prototype, 'status')
markRemote(WorktreeToggleService.prototype, 'enable')

export { WorktreeToggleService }
export const name = 'worktree-toggle'
export const inject = []

export function apply(ctx) {
  const service = new WorktreeToggleService(ctx)

  ctx.effect(() => {
    const timer = ctx.get('timer')
    if (timer === undefined) return
    const run = () => {
      void service.sweepIdleWorktrees().catch((error) => {
        console.error('[dsh-worktree-toggle] sweep failed', error)
      })
    }
    const stopInitial = timer.timeout(run, GC.initialDelayMs)
    const stopInterval = timer.interval(run, GC.intervalMs)
    return () => {
      if (typeof stopInitial === 'function') stopInitial()
      if (typeof stopInterval === 'function') stopInterval()
    }
  }, 'dsh-worktree-toggle: idle worktree sweep')
}
