export type Status =
  | 'starting'
  | 'working'
  | 'permission'
  | 'question'
  | 'idle'
  | 'error'
  | 'interrupted'

export type Item = {
  id: string
  text: string
  done: boolean
  active?: boolean
  source: 'claude' | 'me'
  /** The task's longer description (TaskCreate / TaskUpdate). */
  note?: string
  /** What Claude shows while the item is in progress ("Adding tests"). */
  activeForm?: string
  owner?: string
  /** Task ids this item waits on. */
  blockedBy?: string[]
}

/** A subagent the session started, alone or as one of a workflow's agents. */
export type Agent = {
  id: string
  /** The Agent call's short description. */
  label: string
  /** The agent type (general-purpose, Explore, ...). */
  type: string
  /** The workflow's name and run, when a workflow script started it. */
  workflow?: string
  runId?: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  /** The tool it last called. */
  tool?: string
  /** Tool calls it has made. */
  steps: number
  startedAt: number
  endedAt?: number
}

/** How to bring a session's window to the front; each field is best effort. */
export type Jump = {
  iterm?: string
  tty?: string
  tmuxPane?: string
  app?: string
}

/** One session's record, kept as <id>.json in the shared folder. */
export type Session = {
  id: string
  cwd: string
  title?: string
  /** The last few prompts the person typed, newest last; the title is made from them. */
  prompts: string[]
  /** How many prompts the current title was made from. */
  titledAt: number
  status: Status
  detail?: string
  updatedAt: number
  seenAt: number
  jump: Jump
  items: Item[]
  agents: Agent[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-hub': {
      sessions: Shaped<Session[]>
      /** The session whose checklist the lower half shows; '' means this one. */
      selected: Shaped<string>
    }
  }
}
