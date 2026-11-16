import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-hub',
  component: 'Pane',
  requestId: 'session-hub',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function harness($: any, on: any) {
  const files = new Map<string, string>()
  on('env.get', (_: unknown, e: { name: string }) => ({
    value: ({ HOME: '/home/u' } as Record<string, string>)[e.name],
  }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/shop-api' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', () => ({
    value: [...files.keys()].map(p => ({ name: p.split('/').pop()!, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.PermissionRequest', () => ({}))
  return () => JSON.parse(files.get('/home/u/.claude/session-hub/s1.json')!)
}

test('permission only when a dialog is raised; agents and workflows tracked', async ($, on) => {
  const record = harness($, on)
  on('tool.check', () => ({ decision: 'ask' })) // auto mode: the classifier settles it
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_: unknown, e: { workflow?: unknown }) => ({ model: 'm', agentId: e.workflow ? 'w1' : 'a1' }))

  await $.session.start({ cwd: '/work/shop-api', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'review it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(record().status).toBe('working')

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(record().status).toBe('permission')
  await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(record().status).toBe('working')

  await $.tool.call({ tool: 'Workflow', script: "export const meta = { name: 'review-changes' }", tool_use_id: 'wf' } as any)
  await $.agent.spawn({ prompt: 'p', description: 'review:bugs', subagentType: 'general-purpose', tool_use_id: 'wf', workflow: { runId: 'wf_1', agentIndex: 1 } } as any)
  await $.agent.spawn({ prompt: 'p', description: 'find auth', subagentType: 'Explore' } as any)
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'w1' } as any)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: 'a1' } as any)

  const agents = record().agents
  expect(agents.find((a: any) => a.id === 'w1')).toMatchObject({ workflow: 'review-changes', steps: 1, tool: 'Grep', status: 'running' })
  expect(agents.find((a: any) => a.id === 'a1')).toMatchObject({ type: 'Explore', status: 'done' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /review-changes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0\/1 agents/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /find auth/ })).toBeDefined()
    await ui.unmount()
  }
})

test('status and Claude todos reach the shared record and the pane', async ($, on) => {
  const files = new Map<string, string>()
  const DIR = '/home/u/.claude-work/session-hub'
  on('env.get', (_, e) => ({
    value: ({ HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude-work/', ITERM_SESSION_ID: 'w0t1p0:ABC-123' } as Record<string, string>)[e.name],
  }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/shop-api' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ttys004\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', () => ({
    value: [...files.keys()].map(p => ({
      name: p.split('/').pop()!,
      kind: 'file' as const,
      size: 1,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/work/shop-api', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add the refund endpoint', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'write handler', status: 'completed', activeForm: 'Writing handler' },
      { content: 'add tests', status: 'in_progress', activeForm: 'Adding tests' },
    ],
  })

  const record = JSON.parse(files.get(`${DIR}/s1.json`)!)
  expect(record.jump.iterm).toBe('ABC-123')
  expect(record.jump.tty).toBe('/dev/ttys004')
  expect(record.title).toBe('add the refund endpoint')
  expect(record.status).toBe('working')
  expect(record.prompts).toEqual(['add the refund endpoint'])
  expect(record.items.map((i: { text: string; done: boolean }) => [i.text, i.done])).toEqual([
    ['write handler', true],
    ['add tests', false],
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /add tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Adding tests…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 in progress/ })).toBeDefined()
  await ui.unmount()
})
