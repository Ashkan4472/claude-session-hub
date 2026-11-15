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
  await ui.unmount()
})
