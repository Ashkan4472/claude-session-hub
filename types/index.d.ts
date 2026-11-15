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
