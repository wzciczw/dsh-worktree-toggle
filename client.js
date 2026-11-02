/**
 * dsh-worktree-toggle — Client half.
 *
 * One compact switch beside the composer's Git branch pill (the same
 * `conversation.input.left` seat the git panel uses). It keeps the tool row on
 * a single line: the label never changes, so no state shifts the layout and no
 * worktree or branch name is rendered.
 *
 *   blank session in a git checkout   -> switch (tick it to create a worktree)
 *   session already in a worktree     -> same switch, checked and read-only
 *   anything else                     -> nothing
 */

window.__ModuleLoader__.load({
  id: 'dsh-worktree-toggle',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-worktree-toggle'

    const DICT = {
      zh: {
        label: 'Worktree',
        busy: '创建中…',
        hint: '勾选后在新的 git worktree 中继续此会话：新建分支，原检出保持不变',
        activeHint: '此会话运行在 git worktree 中',
        failed: '创建 worktree 失败',
        'reason:no-session': '没有可用的会话',
        'reason:not-new': '会话已经开始，不能再切换 worktree',
        'reason:no-directory': '会话还没有工作目录',
        'reason:not-a-repo': '当前目录不是 git 仓库',
        'reason:already-worktree': '当前会话已经在 worktree 中',
        'reason:no-agent': '会话尚未就绪，请稍后重试',
        'reason:unavailable': '宿主没有启用 worktree 能力',
        'reason:create-failed': '创建 worktree 失败',
      },
      en: {
        label: 'Worktree',
        busy: 'Creating…',
        hint: 'Run this session in a new git worktree: a new branch, the source checkout untouched',
        activeHint: 'This session runs in a git worktree',
        failed: 'Could not create the worktree',
        'reason:no-session': 'No session available',
        'reason:not-new': 'The session already started',
        'reason:no-directory': 'The session has no working directory yet',
        'reason:not-a-repo': 'This directory is not a git repository',
        'reason:already-worktree': 'This session already runs in a worktree',
        'reason:no-agent': 'The session is not ready yet, try again',
        'reason:unavailable': 'The host does not provide worktrees',
        'reason:create-failed': 'Could not create the worktree',
      },
    }

    function createRpc(ctx) {
      try {
        const connection = ctx.get('connection')
        const rpc = connection?.rpc
        if (rpc === undefined || typeof rpc.call !== 'function') return undefined
        const call = rpc.call.bind(rpc)
        return (method, payload) => Promise.resolve(call('/api', `worktreeToggle/${method}`, { args: { req: payload } }))
      } catch {
        return undefined
      }
    }

    function bindTranslate(ctx) {
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') return (key) => String(bound(key))
        }
      } catch {}
      return (key) => key
    }

    /* One-line tool-row geometry: fixed width in every state, no wrapping. */
    const PILL = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      flex: '0 0 auto',
      height: 22,
      padding: '0 7px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 11.5,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      userSelect: 'none',
    }

    const ACTIVE = {
      borderColor: 'var(--dsw-alias-state-success-primary)',
      color: 'var(--dsw-alias-state-success-primary)',
      cursor: 'default',
    }

    const BUSY = { opacity: 0.65, cursor: 'progress' }

    const FAILED = {
      borderColor: 'var(--dsw-alias-state-error-primary)',
      color: 'var(--dsw-alias-state-error-primary)',
    }

    function boxStyle(active) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: 10,
        height: 10,
        borderRadius: 3,
        border: `1px solid ${active ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'}`,
        background: active ? 'var(--dsw-alias-state-success-primary)' : 'transparent',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 7,
        lineHeight: 1,
      }
    }

    /** The switch itself. Renders nothing until the Host reports a usable state. */
    function Toggle(props) {
      const { sessionId, call, tr } = props
      const [state, setState] = React.useState({ phase: 'loading' })
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null || call === undefined) {
          setState({ phase: 'hidden' })
          return
        }
        let live = true
        setState({ phase: 'loading' })
        call('status', { sessionId }).then((response) => {
          if (!live) return
          setState(derive(response))
        }).catch((error) => {
          console.error('[dsh-worktree-toggle] status failed', error)
          if (live) setState({ phase: 'hidden' })
        })
        return () => {
          live = false
        }
      }, [sessionId, call])

      function derive(response) {
        if (response === undefined || response === null || response.ok !== true) return { phase: 'hidden' }
        const payload = response.value
        if (payload === undefined || payload === null || payload.ok !== true) return { phase: 'hidden' }
        const value = payload.value
        if (value === undefined || value === null || value.repo !== true) return { phase: 'hidden' }
        if (value.worktree === true) return { phase: 'active', path: value.path }
        if (value.blank !== true) return { phase: 'hidden' }
        return { phase: 'idle' }
      }

      function onEnable() {
        if (state.phase !== 'idle' || call === undefined) return
        setState({ phase: 'busy' })
        call('enable', { sessionId }).then((response) => {
          if (!alive.current) return
          const ok = response !== undefined && response !== null && response.ok === true
          const payload = ok ? response.value : undefined
          if (payload !== undefined && payload !== null && payload.ok === true) {
            setState({ phase: 'active', path: payload.value?.path })
            return
          }
          const reason = payload !== undefined && payload !== null && payload.ok === false
            ? String(payload.reason ?? 'create-failed')
            : 'unavailable'
          setState({ phase: 'idle', error: tr(`reason:${reason === 'unavailable' ? 'unavailable' : reason}`) })
        }).catch((error) => {
          console.error('[dsh-worktree-toggle] enable failed', error)
          if (alive.current) setState({ phase: 'idle', error: tr('failed') })
        })
      }

      if (state.phase === 'hidden' || state.phase === 'loading') return null

      const active = state.phase === 'active'
      const busy = state.phase === 'busy'
      const failed = state.phase === 'idle' && state.error !== undefined
      const title = failed
        ? state.error
        : active
          ? `${tr('activeHint')}\n${state.path ?? ''}`
          : busy
            ? tr('busy')
            : tr('hint')

      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': active,
          'aria-label': tr('label'),
          title,
          disabled: active || busy,
          onClick: onEnable,
          style: {
            ...PILL,
            ...(active ? ACTIVE : undefined),
            ...(busy ? BUSY : undefined),
            ...(failed ? FAILED : undefined),
          },
        },
        h('span', { key: 'box', style: boxStyle(active) }, active ? '\u2713' : ''),
        h('span', { key: 'label' }, tr('label')),
      )
    }

    function apply(ctx) {
      const call = createRpc(ctx)

      ctx.effect(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)

      const fallbackTr = bindTranslate(ctx)

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'worktree-toggle',
            order: 101,
          },
          (props) =>
            h(Toggle, {
              sessionId: props === undefined ? undefined : props.sessionId,
              call,
              tr: fallbackTr,
            }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply,
    }
  },
})
