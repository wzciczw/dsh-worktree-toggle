import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { WorktreeToggleService } from '../host.js'

const DAY = 24 * 60 * 60 * 1000
const base = mkdtempSync(join(tmpdir(), 'wt-toggle-'))
const repo = join(base, 'repo')
mkdirSync(repo)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 't@example.com')
git(repo, 'config', 'user.name', 'tester')
writeFileSync(join(repo, 'a.txt'), 'a\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'init')

const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`)

/* ---------------------------------------------------------------- status / enable */

const session = { header: { cwd: repo }, ownEvents: () => [] }
const services = {
  sessions: { get: (id) => (id === 's1' ? session : undefined), list: () => [] },
  workingDirectory: { get: () => session.header.cwd },
  agents: { get: () => ({ id: 's1' }) },
  worktrees: {
    async create() {
      const path = join(repo, '.agents', 'worktrees', 'from-enable')
      mkdirSync(join(repo, '.agents', 'worktrees'), { recursive: true })
      execFileSync('git', ['worktree', 'add', '-b', 'from-enable', path], { cwd: repo })
      return { path, branch: 'from-enable', baseCommit: 'x', repositoryRoot: repo }
    },
  },
}
const ctx = { get: (name) => services[name] }
const service = Object.create(WorktreeToggleService.prototype)
service.hostCtx = ctx
service.writeState = () => {}
service.rememberWorktree = () => {}

log('status before', await service.status({ sessionId: 's1' }))
const created = await service.enable({ sessionId: 's1' })
log('enable', created)
session.header.cwd = created.value.path
log('status after', await service.status({ sessionId: 's1' }))
session.ownEvents = () => [{ type: 'user/message' }]
log('enable on started session', await service.enable({ sessionId: 's1' }))
log('status unknown session', await service.status({ sessionId: 'nope' }))

/* ---------------------------------------------------------------- idle sweep */

mkdirSync(join(repo, '.agents', 'worktrees'), { recursive: true })
const poolOld = join(repo, '.agents', 'worktrees', 'old-one')
const poolFresh = join(repo, '.agents', 'worktrees', 'fresh-one')
const poolRegistered = join(repo, '.agents', 'worktrees', 'registered-one')
const outside = join(base, 'outside')
git(repo, 'worktree', 'add', '-b', 'old-one', poolOld)
git(repo, 'worktree', 'add', '-b', 'fresh-one', poolFresh)
git(repo, 'worktree', 'add', '-b', 'registered-one', poolRegistered)
git(repo, 'worktree', 'add', '-b', 'outside-one', outside)

const now = Date.now()
const records = [
  { header: { id: 's-old', cwd: poolOld }, live: false, persisted: true },
  { header: { id: 's-fresh', cwd: poolFresh }, live: false, persisted: true },
  { header: { id: 's-outside', cwd: outside }, live: false, persisted: true },
  { header: { id: 's-live', cwd: repo }, live: true, persisted: true },
]
const activity = new Map([
  ['s-old', now - 4 * DAY],
  ['s-fresh', now - 1 * DAY],
  ['s-outside', now - 4 * DAY],
  ['s-registered', now - 5 * DAY],
])
const registry = [{ path: poolRegistered, sessionId: 's-registered', createdAt: now - 6 * DAY }]

services.sessions = { get: () => undefined, list: () => [{ header: { cwd: repo }, ownEvents: () => [] }] }
services.sessionQuery = {
  async listSessions() {
    return records
  },
  async listEvents(id) {
    const time = activity.get(id)
    return time === undefined ? [] : [{ type: 'user/message', time }]
  },
}
service.readRegistry = () => registry
service.writeRegistry = () => {}

const firstSweep = await service.sweepIdleWorktrees()
log('sweep #1 deferred', firstSweep.deferred.map((item) => item.path))
log('sweep #1 removed', firstSweep.removed.map((item) => item.path))
log('old worktree exists after #1', existsSync(poolOld))
log('registered worktree exists after #1', existsSync(poolRegistered))

const secondSweep = await service.sweepIdleWorktrees()
log('sweep #2 removed', secondSweep.removed.map((item) => item.path))
log('sweep #2 skipped', secondSweep.skipped)
log('old worktree exists after #2', existsSync(poolOld))
log('registered worktree exists after #2', existsSync(poolRegistered))
log('fresh worktree exists', existsSync(poolFresh))
log('outside worktree exists', existsSync(outside))
