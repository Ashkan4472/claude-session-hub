import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Agent, Item, Jump, Session, Status } from '../types'

const PANE = 'session-hub'
const POLL_MS = 2000
const HEARTBEAT_MS = 20_000
// A session that has not written for this long crashed or was killed.
const STALE_MS = 90_000
const KEEP_PROMPTS = 6
// Finished agents stay listed this long.
const KEEP_AGENT_MS = 10 * 60_000

const sessions = atom({ plugin: 'session-hub', key: 'sessions' } as const, [], {
  shape: 'sessions-3',
})
const selected = atom({ plugin: 'session-hub', key: 'selected' } as const, '', {
  shape: 'selected-1',
})

// Set at session.start; a reload runs session.start again.
let dir = ''
let me = ''
// Workflow names by the Workflow call's id; its agents' spawns carry that id.
const workflowNames = new Map<string, string>()
// Permission dialogs open now, by loop ('' is the main loop, else the agent id).
// While any is open the status stays "needs permission"; what would have been
// shown meanwhile waits in beforeAsk.
const asking = new Map<string, string>()
let beforeAsk: Status = 'working'

const file = (id: string) => `${dir}/${id}.json`

async function load($: Engine, id: string): Promise<Session | undefined> {
  try {
    const s = JSON.parse(await $.fs.read(file(id))) as Session
    return { ...s, prompts: s.prompts ?? [], titledAt: s.titledAt ?? 0, items: s.items ?? [], agents: s.agents ?? [] }
  } catch {
    return undefined
  }
}

// Writes from this process run one at a time, so parallel subagents' updates
// don't overwrite each other.
// ponytail: no lock across processes; two sessions editing the same record in
// the same millisecond can lose one edit. Add a lock file if that bites.
let queue: Promise<unknown> = Promise.resolve()
function patch($: Engine, id: string, fn: (s: Session) => Session) {
  const run = queue.then(async () => {
    if (!dir) return
    const s = await load($, id)
    if (!s) return
    await $.fs.write(file(id), JSON.stringify({ ...fn(s), seenAt: Date.now() }))
    await refresh($)
  })
  queue = run.catch(() => undefined)
  return run
}

function setStatus($: Engine, status: Status, detail?: string) {
  if (status !== 'permission' && asking.size > 0) {
    beforeAsk = status
    return Promise.resolve()
  }
  return patch($, me, s => {
    if (status === 'permission' && s.status !== 'permission') beforeAsk = s.status
    return { ...s, status, detail, updatedAt: Date.now() }
  })
}

// A loop's dialog was answered (or its call ended): show the next open one, or
// what the session is doing.
async function settle($: Engine, loop: string) {
  if (!asking.delete(loop)) return
  const next = asking.values().next().value
  await (next === undefined ? setStatus($, beforeAsk) : setStatus($, 'permission', next))
}

const setItems = ($: Engine, id: string, fn: (items: Item[]) => Item[]) =>
  patch($, id, s => ({ ...s, items: fn(s.items) }))

const setAgent = ($: Engine, agentId: string, fn: (a: Agent) => Agent) =>
  patch($, me, s => {
    const now = Date.now()
    return {
      ...s,
      agents: s.agents
        .map(a => (a.id === agentId ? fn(a) : a))
        .filter(a => a.status === 'running' || now - (a.endedAt ?? now) < KEEP_AGENT_MS),
    }
  })

function workflowName(e: { name?: string; script?: string; scriptPath?: string }) {
  const meta = e.script?.match(/\bname\s*:\s*['"`]([^'"`]+)/)?.[1]
  return e.name ?? meta ?? (e.scriptPath ? basename(e.scriptPath).replace(/\.\w+$/, '') : 'workflow')
}

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

const AGENT_LOOK: Record<Agent['status'], { glyph: string; color: string }> = {
  running: { glyph: '◉', color: 'warning' },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✕', color: 'error' },
  interrupted: { glyph: '◼', color: 'inactive' },
}

// Agents in the order they started, a workflow's gathered under its first.
function groupAgents(agents: Agent[]) {
  const groups: { workflow?: string; agents: Agent[] }[] = []
  for (const a of agents) {
    const g = a.runId ? groups.find(x => x.agents[0]?.runId === a.runId) : undefined
    if (g) g.agents.push(a)
    else groups.push({ workflow: a.workflow, agents: [a] })
  }
  return groups
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
      agents: old?.agents ?? [],
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
    } else {
      // A teammate woken again runs another turn.
      const id = e.agentId
      await setAgent($, id, a => ({ ...a, status: 'running', endedAt: undefined }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      asking.delete('')
      const status: Status =
        e.reason === 'answer' ? 'idle' : e.reason === 'aborted' ? 'interrupted' : 'error'
      await setStatus($, status, e.reason === 'refusal' ? 'refused' : undefined)
      if (e.reason === 'answer') void retitle($).catch(() => undefined)
    } else {
      const status: Agent['status'] =
        e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'interrupted' : 'failed'
      const id = e.agentId
      await settle($, id)
      await setAgent($, id, a => ({ ...a, status, tool: undefined, endedAt: Date.now() }))
    }
    return next(e)
  })

  // Only a dialog actually put to the person counts. A tool.check 'ask' does
  // not: in auto mode the classifier settles most asks with nobody asked.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.tool_name !== 'AskUserQuestion') {
      const who = e.agent_id
        ? (await load($, me))?.agents.find(a => a.id === e.agent_id)?.label
        : undefined
      const detail = who ? `${e.tool_name} · ${who}` : e.tool_name
      asking.set(e.agent_id ?? '', detail)
      await setStatus($, 'permission', detail)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ponytail: an approved tool shows "needs permission" until it ends, as no
  // event marks the dialog's answer. Hook one if the engine adds it.
  on('classic.PermissionDenied', async ($, e, next) => {
    await settle($, e.agent_id ?? '')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const isAsk = e.tool === 'AskUserQuestion'
    if (e.tool === 'Workflow' && e.tool_use_id) workflowNames.set(e.tool_use_id, workflowName(e))
    if (!e.agentId) await setStatus($, isAsk ? 'question' : 'working', e.tool)
    else {
      const tool = e.tool
      await setAgent($, e.agentId, a => ({ ...a, tool, steps: a.steps + 1 }))
    }
    const ran = await next(e)
    // The permission check runs inside next: by now any dialog was answered.
    await settle($, e.agentId ?? '')
    if (!e.agentId || isAsk) await setStatus($, 'working', isAsk ? undefined : e.tool)
    return ran
  }).catch(($, e, next) => next(e)) // fail open: the hub never blocks a tool

  // Subagents and workflow agents, with their progress.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) {
      const agent: Agent = {
        id: started.agentId,
        label: e.description || e.subagentType,
        type: e.subagentType,
        workflow: e.workflow ? (workflowNames.get(e.tool_use_id) ?? 'workflow') : undefined,
        runId: e.workflow?.runId,
        status: 'running',
        steps: 0,
        startedAt: Date.now(),
      }
      await patch($, me, s => ({
        ...s,
        agents: [...s.agents.filter(a => a.id !== agent.id), agent],
      }))
    }
    return started
  }).catch(($, e, next) => next(e))

  // Claude's own todo lists, copied into the checklist.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const claude: Item[] = e.todos.map(t => ({
        id: `w:${t.content}`,
        text: t.content,
        done: t.status === 'completed',
        active: t.status === 'in_progress',
        activeForm: t.activeForm,
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
      const item: Item = {
        id: `t:${task.id}`,
        text: e.subject,
        note: e.description || undefined,
        activeForm: e.activeForm,
        done: false,
        source: 'claude',
      }
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
                    note: e.description ?? i.note,
                    activeForm: e.activeForm ?? i.activeForm,
                    owner: e.owner ?? i.owner,
                    blockedBy: e.addBlockedBy
                      ? [...new Set([...(i.blockedBy ?? []), ...e.addBlockedBy])]
                      : i.blockedBy,
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
              {groupAgents(s.agents).map(g => {
                const agentLine = (a: Agent, indent: string) => (
                  <Text key={`a:${s.id}:${a.id}`}>
                    {indent}
                    <Text color={AGENT_LOOK[a.status].color}>{AGENT_LOOK[a.status].glyph} </Text>
                    <Text dimColor={a.status !== 'running'}>{a.label}</Text>
                    <Text dimColor>
                      {g.workflow ? '' : ` (${a.type})`}
                      {a.tool ? ` · ${a.tool}` : ''} · {a.steps} steps ·{' '}
                      {ago((a.endedAt ?? now) - a.startedAt)}
                    </Text>
                  </Text>
                )
                if (!g.workflow) return g.agents.map(a => agentLine(a, '  ↳ '))
                const finished = g.agents.filter(a => a.status !== 'running').length
                const running = g.agents.filter(a => a.status === 'running')
                const p = bar(finished, g.agents.length, 8)
                const allDone = running.length === 0
                return (
                  <Box key={`wf:${s.id}:${g.agents[0]?.runId}`} flexDirection="column">
                    <Text>
                      {'  ↳ '}
                      <Text color={allDone ? 'success' : 'warning'}>{allDone ? '✓' : '⚙'} </Text>
                      <Text bold={!allDone}>{g.workflow}</Text>{' '}
                      <Text color="success">{p.full}</Text>
                      <Text dimColor>{p.empty}</Text>
                      <Text dimColor>
                        {' '}
                        {finished}/{g.agents.length} agents
                      </Text>
                    </Text>
                    {running.slice(0, 4).map(a => agentLine(a, '      '))}
                    {running.length > 4 && <Text dimColor>      +{running.length - 4} more running</Text>}
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )

    const items = current?.items ?? []
    const done = items.filter(i => i.done).length
    const active = items.filter(i => i.active && !i.done).length
    const open = items.length - done - active
    const openTasks = new Set(items.filter(i => !i.done).map(i => i.id))
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
        {items.length > 0 && (
          <Text>
            <Text color="success">{done} done</Text>
            <Text dimColor> · </Text>
            <Text color="warning">{active} in progress</Text>
            <Text dimColor> · {open} to do</Text>
          </Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          {items.length === 0 && <Text dimColor>Nothing yet. Claude's todos show here.</Text>}
          {items.map(item => {
            const blockers = (item.blockedBy ?? []).filter(b => openTasks.has(`t:${b}`))
            return (
            <Box key={`i:${sid}:${item.id}`} flexDirection="column">
            <Box justifyContent="space-between">
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
                  {item.done ? '[✓] ' : item.active ? '[•] ' : '[ ] '}
                </Text>
                {item.id.startsWith('t:') ? <Text dimColor>#{item.id.slice(2)} </Text> : ''}
                <Text dimColor={item.done} strikethrough={item.done} bold={item.active}>
                  {item.text}
                </Text>
                {item.source === 'me' ? <Text color="suggestion"> · you</Text> : ''}
                {item.owner ? <Text color="suggestion"> · @{item.owner}</Text> : ''}
              </Button>
              <Button
                key={`x:${sid}:${item.id}`}
                plain
                onPress={() => setItems($, sid, list => list.filter(i => i.id !== item.id))}
              >
                <Text dimColor>✕</Text>
              </Button>
            </Box>
            {item.active && !item.done && item.activeForm && (
              <Text color="warning">{'    '}↳ {item.activeForm}…</Text>
            )}
            {item.note && !item.done && (
              <Text dimColor>
                {'    '}
                {item.note.length > 160 ? `${item.note.slice(0, 159)}…` : item.note}
              </Text>
            )}
            {blockers.length > 0 && !item.done && (
              <Text color="error">
                {'    '}blocked by {blockers.map(b => `#${b}`).join(', ')}
              </Text>
            )}
            </Box>
            )
          })}
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
