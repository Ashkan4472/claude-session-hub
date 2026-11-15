import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Item, Jump, Session, Status } from '../types'

const PANE = 'session-hub'
const POLL_MS = 2000
const HEARTBEAT_MS = 20_000
// A session that has not written for this long crashed or was killed.
const STALE_MS = 90_000
const KEEP_PROMPTS = 6

const sessions = atom({ plugin: 'session-hub', key: 'sessions' } as const, [], {
  shape: 'sessions-2',
})
const selected = atom({ plugin: 'session-hub', key: 'selected' } as const, '', {
  shape: 'selected-1',
})

// Set at session.start; a reload runs session.start again.
let dir = ''
let me = ''

const file = (id: string) => `${dir}/${id}.json`

async function load($: Engine, id: string): Promise<Session | undefined> {
  try {
    const s = JSON.parse(await $.fs.read(file(id))) as Session
    return { ...s, prompts: s.prompts ?? [], titledAt: s.titledAt ?? 0, items: s.items ?? [] }
  } catch {
    return undefined
  }
}

// ponytail: read-modify-write without a lock; two sessions editing the same
// record in the same millisecond can lose one edit. Add a lock file if that bites.
async function patch($: Engine, id: string, fn: (s: Session) => Session) {
  if (!dir) return
  const s = await load($, id)
  if (!s) return
  await $.fs.write(file(id), JSON.stringify({ ...fn(s), seenAt: Date.now() }))
  await refresh($)
}

const setStatus = ($: Engine, status: Status, detail?: string) =>
  patch($, me, s => ({ ...s, status, detail, updatedAt: Date.now() }))

const setItems = ($: Engine, id: string, fn: (items: Item[]) => Item[]) =>
  patch($, id, s => ({ ...s, items: fn(s.items) }))

async function refresh($: Engine) {
  if (!dir) return
  const entries = await $.fs.list(dir).catch(() => [])
  const now = Date.now()
  const list: Session[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const s = await load($, entry.name.slice(0, -5))
    if (!s) continue
    if (now - s.seenAt > STALE_MS) {
      await $.process.run(['rm', '-f', file(s.id)]).catch(() => undefined)
      continue
    }
    list.push(s)
  }
  list.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id))
  if (JSON.stringify(await read($, sessions)) !== JSON.stringify(list)) {
    await update($, sessions, () => list)
  }
}

// The title follows the conversation: a short Haiku call after a turn that
// brought a new prompt. The first prompt's line stands in until it answers.
async function retitle($: Engine) {
  const s = await load($, me)
  if (!s || s.prompts.length === 0 || s.titledAt === s.prompts.length) return
  const open = s.items.filter(i => !i.done).map(i => `- ${i.text}`).join('\n')
  const answer = await $.model.complete({
    model: 'haiku',
    maxTokens: 24,
    system:
      'You name coding sessions for a dashboard. Reply with only a title of 2 to 6 words, no quotes, no trailing period, describing what the session is working on now.',
    prompt: `Requests in this session, oldest first:\n${s.prompts.map(p => `- ${p}`).join('\n')}${open ? `\n\nOpen tasks:\n${open}` : ''}`,
  })
  const title = answer.isAnswered ? answer.text.trim().split('\n')[0]?.replace(/^["']|["'.]$/g, '') : ''
  await patch($, me, x => ({
    ...x,
    title: title ? title.slice(0, 60) : x.title,
    titledAt: s.prompts.length,
  }))
}

async function configDir($: Engine) {
  const custom = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  return custom ? custom.replace(/\/+$/, '') : `${await $.env.get('HOME')}/.claude`
}

async function whereAmI($: Engine): Promise<Jump> {
  const jump: Jump = {}
  const iterm = await $.env.get('ITERM_SESSION_ID')
  if (iterm) jump.iterm = iterm.split(':').pop()
  if (await $.env.get('TMUX')) jump.tmuxPane = await $.env.get('TMUX_PANE')
  jump.app = await $.env.get('TERM_PROGRAM')
  if ((await $.session.surface()) === 'desktop') jump.app = 'claude-desktop'
  const ps = await $.process
    .run(['sh', '-c', 'ps -o tty= -p $PPID'])
    .catch(() => undefined)
  const tty = ps?.stdout.trim()
  if (tty && tty !== '??') jump.tty = `/dev/${tty}`
  return jump
}

const APPS: Record<string, string> = {
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  ghostty: 'Ghostty',
  WarpTerminal: 'Warp',
  vscode: 'Visual Studio Code',
  WezTerm: 'WezTerm',
  'claude-desktop': 'Claude',
}

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`

async function jumpTo($: Engine, j: Jump) {
  // A failed step shows its error instead of failing silently.
  const run = async (argv: string[]) => {
    const r = await $.process.run(argv).catch((err: unknown) => ({
      exitCode: -1,
      stdout: '',
      stderr: String(err),
    }))
    if (r.exitCode !== 0) $.ui.toast(`session-hub: ${argv[0]} failed: ${r.stderr.trim().slice(0, 160)}`)
    return r
  }
  if (j.tmuxPane) {
    await run(['tmux', 'switch-client', '-t', j.tmuxPane])
    await run(['tmux', 'select-window', '-t', j.tmuxPane])
    await run(['tmux', 'select-pane', '-t', j.tmuxPane])
  }
  if (j.iterm) {
    await run([
      'osascript',
      '-e',
      `tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is ${quote(j.iterm)} then
          tell w to select
          tell t to select
          tell s to select
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`,
    ])
    return
  }
  if (j.app === 'Apple_Terminal' && j.tty) {
    await run([
      'osascript',
      '-e',
      `tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${quote(j.tty)} then
        set selected tab of w to t
        set index of w to 1
        return
      end if
    end repeat
  end repeat
end tell`,
    ])
    return
  }
  // Other terminals and the desktop app: bring the app forward, no tab pick.
  const app = j.app && APPS[j.app]
  if (app) await run(['open', '-a', app])
}

const LOOK: Record<Status, { glyph: string; color: string; label: string }> = {
  starting: { glyph: '◌', color: 'inactive', label: 'starting' },
  working: { glyph: '◉', color: 'warning', label: 'working' },
  permission: { glyph: '⚑', color: 'permission', label: 'needs permission' },
  question: { glyph: '?', color: 'permission', label: 'asks you' },
  idle: { glyph: '●', color: 'success', label: 'your turn' },
  error: { glyph: '✕', color: 'error', label: 'error' },
  interrupted: { glyph: '◼', color: 'inactive', label: 'interrupted' },
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

function bar(done: number, total: number, width = 10) {
  const full = total ? Math.round((done / total) * width) : 0
  return { full: '━'.repeat(full), empty: '━'.repeat(width - full) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    dir = `${await configDir($)}/session-hub`
    me = await $.session.id()
    const old = await load($, me) // a reload keeps the record
    const now = Date.now()
    const record: Session = {
      id: me,
      cwd: await $.session.cwd(),
      title: old?.title,
      prompts: old?.prompts ?? [],
      titledAt: old?.titledAt ?? 0,
      status: old?.status ?? 'starting',
      detail: old?.detail,
      updatedAt: old?.updatedAt ?? now,
      seenAt: now,
      jump: await whereAmI($),
      items: old?.items ?? [],
    }
    await $.fs.write(file(me), JSON.stringify(record))

    await $.command.register({
      name: 'sessions',
      description: 'Open the session hub pane',
    })
    $.clock.every(POLL_MS, () => void refresh($))
    $.clock.every(HEARTBEAT_MS, () => void patch($, me, s => s))
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Sessions', columns: 52 })
    return started
  })

  on('session.end', async ($, e, next) => {
    if (dir) await $.process.run(['rm', '-f', file(e.sessionId)]).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions', columns: 52, focus: true })
    return { text: 'Session hub opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      // Notifications and other machine turns start with a tag: not the person's words.
      const line = e.text.trim().split('\n')[0] ?? ''
      const typed = line && !line.startsWith('<') ? line.slice(0, 200) : undefined
      await patch($, me, s => ({
        ...s,
        prompts: typed ? [...s.prompts, typed].slice(-KEEP_PROMPTS) : s.prompts,
        title: s.title && !s.title.startsWith('<') ? s.title : typed?.slice(0, 60),
        status: 'working',
        detail: undefined,
        updatedAt: Date.now(),
      }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const status: Status =
        e.reason === 'answer' ? 'idle' : e.reason === 'aborted' ? 'interrupted' : 'error'
      await setStatus($, status, e.reason === 'refusal' ? 'refused' : undefined)
      if (e.reason === 'answer') void retitle($).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.approver === 'person') {
      await setStatus($, 'permission', e.tool)
    }
    return verdict
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  on('tool.call', async ($, e, next) => {
    const isAsk = e.tool === 'AskUserQuestion'
    if (!e.agentId) await setStatus($, isAsk ? 'question' : 'working', e.tool)
    const ran = await next(e)
    // Back to working once answered or approved (the permission check runs inside next).
    if (!e.agentId || isAsk) await setStatus($, 'working', isAsk ? undefined : e.tool)
    return ran
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  // Claude's own todo lists, copied into the checklist.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const claude: Item[] = e.todos.map(t => ({
        id: `w:${t.content}`,
        text: t.content,
        done: t.status === 'completed',
        active: t.status === 'in_progress',
        source: 'claude',
      }))
      await setItems($, me, items => [...claude, ...items.filter(i => i.source === 'me')])
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: string } } | undefined)?.task
    if (ran.deny === undefined && !ran.isError && task?.id) {
      const item: Item = { id: `t:${task.id}`, text: e.subject, done: false, source: 'claude' }
      await setItems($, me, items => [...items.filter(i => i.id !== item.id), item])
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const id = `t:${e.taskId}`
      await setItems($, me, items =>
        e.status === 'deleted'
          ? items.filter(i => i.id !== id)
          : items.map(i =>
              i.id !== id
                ? i
                : {
                    ...i,
                    text: e.subject ?? i.text,
                    done: e.status ? e.status === 'completed' : i.done,
                    active: e.status ? e.status === 'in_progress' : i.active,
                  },
            ),
      )
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, sessions)
    const picked = (await read($, selected)) || me
    const current = list.find(s => s.id === picked) ?? list.find(s => s.id === me)
    const now = Date.now()
    const rows = e.props.scroll?.bodyRows ?? 30
    const topRows = Math.max(8, Math.floor(rows * 0.55))

    // One click on a session selects it (its todos show below) and jumps to its tab.
    const openSession = async (s: Session) => {
      await update($, selected, () => s.id)
      if (s.id !== me) await jumpTo($, s.jump)
    }

    const counts = (['working', 'permission', 'question', 'idle', 'error'] as const)
      .map(st => [st, list.filter(s => s.status === st).length] as const)
      .filter(([, n]) => n > 0)

    const sessionsPanel = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
        height={topRows}
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold color="claude">
            Sessions <Text dimColor>{list.length}</Text>
          </Text>
          <Text>
            {counts.map(([st, n]) => (
              <Text color={LOOK[st].color}>
                {' '}
                {LOOK[st].glyph}
                {n}
              </Text>
            ))}
          </Text>
        </Box>
        {list.length === 0 && <Text dimColor>No sessions yet.</Text>}
        {list.map(s => {
          const look = LOOK[s.status]
          const isSel = s.id === current?.id
          const done = s.items.filter(i => i.done).length
          return (
            <Box key={`row:${s.id}`} flexDirection="column" marginTop={1}>
              <Box justifyContent="space-between">
                <Button key={`sel:${s.id}`} plain onPress={() => openSession(s)}>
                  <Text color={isSel ? 'claude' : 'inactive'}>{isSel ? '▌' : ' '}</Text>
                  <Text color={look.color}>{look.glyph} </Text>
                  <Text bold={isSel}>{basename(s.cwd)}</Text>
                  {s.id === me ? <Text color="suggestion"> · here</Text> : ''}
                </Button>
                {s.id !== me && (
                  <Button key={`go:${s.id}`} plain onPress={() => openSession(s)}>
                    <Text color="suggestion">↗</Text>
                  </Button>
                )}
              </Box>
              <Button key={`title:${s.id}`} plain onPress={() => openSession(s)}>
                <Text bold={isSel} dimColor={!isSel}>
                  {'  '}
                  {s.title ?? 'new session'}
                </Text>
              </Button>
              <Text>
                {'  '}
                <Text color={look.color}>{look.label}</Text>
                <Text dimColor>
                  {s.detail ? ` · ${s.detail}` : ''} · {ago(now - s.updatedAt)}
                  {s.items.length ? ` · ${done}/${s.items.length}` : ''}
                </Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    const items = current?.items ?? []
    const done = items.filter(i => i.done).length
    const progress = bar(done, items.length)
    const sid = current?.id ?? me

    const todoPanel = (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="suggestion"
        paddingX={1}
        flexGrow={1}
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold color="suggestion">
            Todo <Text dimColor>· {current ? basename(current.cwd) : '—'}</Text>
          </Text>
          <Text>
            <Text color="success">{progress.full}</Text>
            <Text dimColor>{progress.empty}</Text>
            <Text dimColor>
              {' '}
              {done}/{items.length}
            </Text>
          </Text>
        </Box>
        {current?.title && <Text dimColor>{current.title}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {items.length === 0 && <Text dimColor>Nothing yet. Claude's todos show here.</Text>}
          {items.map(item => (
            <Box key={`i:${sid}:${item.id}`} justifyContent="space-between">
              <Button
                key={`t:${sid}:${item.id}`}
                plain
                onPress={() =>
                  setItems($, sid, list =>
                    list.map(i => (i.id === item.id ? { ...i, done: !i.done } : i)),
                  )
                }
              >
                <Text color={item.done ? 'success' : item.active ? 'warning' : 'inactive'}>
                  {item.done ? '✔ ' : item.active ? '◐ ' : '○ '}
                </Text>
                <Text dimColor={item.done} strikethrough={item.done} bold={item.active}>
                  {item.text}
                </Text>
                {item.source === 'me' ? <Text color="suggestion"> · you</Text> : ''}
              </Button>
              <Button
                key={`x:${sid}:${item.id}`}
                plain
                onPress={() => setItems($, sid, list => list.filter(i => i.id !== item.id))}
              >
                <Text dimColor>✕</Text>
              </Button>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Input
            key={`add:${sid}`}
            label="+ "
            placeholder="add a todo…"
            submitLabel="add"
            onSubmit={text => {
              const t = text.trim()
              if (t)
                void setItems($, sid, list => [
                  ...list,
                  { id: `m:${Date.now()}`, text: t, done: false, source: 'me' },
                ])
            }}
          />
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" height={rows}>
        {sessionsPanel}
        {todoPanel}
      </Box>
    )
  })
}
