import type { ModelUsage } from 'claude-code'

import type { AgentBoardRow, AgentBoardTokens } from '../types'

export const IDLE_MS = 120_000

/**
 * What the session is doing, for a board that watches several at once: working on a turn, waiting
 * on the person (a question, a permission dialog), or idle with its turn done.
 */
export type SessionActivity = {
  state: 'working' | 'waiting' | 'idle'
  /** Milliseconds since the epoch the state began (Date.now(): the board compares it with its own clock). */
  since: number
  /** For `waiting`: what it waits on, to show. */
  reason?: string
  /** For `waiting`: a question clears when it is answered; a permission when the next step starts. */
  kind?: 'question' | 'permission'
}

/** One window of the subscription's usage limits, as claude.ai's usage page shows it. */
export type PlanWindow = {
  key: string
  label: string
  /** Share of the window used, 0-100. */
  percent: number
  resetsAt?: string
}

/** Extra usage (overage) for the billing period; amounts in minor units of `currency` (cents for USD). */
export type PlanExtra = {
  percent: number | null
  usedCredits: number | null
  monthlyLimit: number | null
  currency: string | null
}

export type PlanUsage = {
  fetchedAt: number
  windows: PlanWindow[]
  extra?: PlanExtra
}

const PLAN_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['five_hour', '5-hour session'],
  ['seven_day', 'Weekly · all models'],
  ['seven_day_opus', 'Weekly · Opus'],
  ['seven_day_sonnet', 'Weekly · Sonnet'],
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function windowOf(key: string, label: string, value: unknown): PlanWindow | undefined {
  const record = asRecord(value)
  const percent = numberOrNull(record?.utilization)
  if (record === undefined || percent === null) {
    return undefined
  }
  const resetsAt = record.resets_at

  return typeof resetsAt === 'string' ? { key, label, percent, resetsAt } : { key, label, percent }
}

/**
 * Reads the body of `GET /api/oauth/usage` (what Claude Code's /usage reads): the 5-hour and weekly
 * windows, any per-model weekly bucket, and extra usage. The endpoint is not a public API and its
 * shape may change: whatever does not read as a window is left out, and no window at all is undefined.
 */
export function parsePlanUsage(body: unknown, fetchedAt: number): PlanUsage | undefined {
  const record = asRecord(body)
  if (record === undefined) {
    return undefined
  }

  const windows: PlanWindow[] = []
  for (const [key, label] of PLAN_WINDOWS) {
    const window = windowOf(key, label, record[key])
    if (window !== undefined) {
      windows.push(window)
    }
  }
  for (const list of [record.model_scoped, record.limits]) {
    if (!Array.isArray(list)) {
      continue
    }
    for (const item of list) {
      const name = asRecord(item)?.display_name
      if (typeof name === 'string' && !windows.some(window => window.key === `model:${name}`)) {
        const window = windowOf(`model:${name}`, `Weekly · ${name}`, item)
        if (window !== undefined) {
          windows.push(window)
        }
      }
    }
  }
  if (windows.length === 0) {
    return undefined
  }

  const extra = asRecord(record.extra_usage)
  if (extra?.is_enabled === true) {
    return {
      fetchedAt,
      windows,
      extra: {
        percent: numberOrNull(extra.utilization),
        usedCredits: numberOrNull(extra.used_credits),
        monthlyLimit: numberOrNull(extra.monthly_limit),
        currency: typeof extra.currency === 'string' ? extra.currency : null,
      },
    }
  }

  return { fetchedAt, windows }
}

/** The subscription a session is signed in to: what tells one account's usage from another's. */
export type PlanAccount = {
  /** Short and safe in a file name: the start of the organization's id (the limits are the organization's). */
  id: string
  /** The sign-in's email, to show. */
  label?: string
}

/**
 * Reads the body of `GET /api/oauth/profile`: who the session's credential belongs to. Not a public
 * API either: undefined where no id reads.
 */
export function parseAccount(body: unknown): PlanAccount | undefined {
  const record = asRecord(body)
  const account = asRecord(record?.account)
  const uuid = asRecord(record?.organization)?.uuid ?? account?.uuid
  const id = typeof uuid === 'string' ? uuid.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) : ''
  if (id === '') {
    return undefined
  }
  const label = [account?.email, account?.email_address, account?.display_name].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )

  return label === undefined ? { id } : { id, label: label.trim() }
}

/** The shared read's file: one per account, so two sign-ins on one machine never overwrite each other's. */
export function planFileOf(account: PlanAccount | undefined): string {
  return account === undefined ? 'plan.json' : `plan-${account.id}.json`
}

/** When a read's weekly window ends: what tells one account's readings from another's. */
export function weekEndOf(plan: PlanUsage | undefined): string | undefined {
  return plan?.windows.find(window => window.key === 'seven_day')?.resetsAt
}

/** Two readings of one weekly window: its end moves by no more than a few minutes between reads. */
const SAME_WEEK_MS = 10 * 60_000

/**
 * Whether a reading of the weekly window is another account's than an earlier one. An account's week
 * ends at one time until it has ended, so a week that ends elsewhere while the earlier one still runs
 * came through another sign-in: a /login moved the credential the session holds to another account.
 * With either end unknown, nothing says so.
 */
export function isAnotherAccountsWeek(earlier: string | undefined, later: string | undefined, at: number): boolean {
  const before = Date.parse(earlier ?? '')
  const after = Date.parse(later ?? '')

  return (
    Number.isFinite(before) &&
    Number.isFinite(after) &&
    at < before - SAME_WEEK_MS &&
    Math.abs(after - before) > SAME_WEEK_MS
  )
}

/**
 * The board's folder: `agent-board` under Claude Code's own folder, which is CLAUDE_CONFIG_DIR
 * where that is set and `.claude` in the home folder otherwise (USERPROFILE on Windows, HOME
 * elsewhere). Forward slashes throughout; undefined with no home known.
 */
export function boardRootOf(
  configDir: string | undefined,
  userProfile: string | undefined,
  home: string | undefined,
): string | undefined {
  const set = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim()
  const person = set(userProfile) ?? set(home)
  const base = set(configDir) ?? (person === undefined ? undefined : `${person.replace(/[\\/]+$/, '')}/.claude`)

  return base === undefined ? undefined : `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/agent-board`
}

/** One line, at most `max` characters. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The last two segments of a path, either slash. */
export function tailPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/')
}

/** What a subagent's tool call is doing, short enough for one row. */
export function describeCall(args: Readonly<Record<string, unknown>>): string {
  const tool = String(args.tool)
  const text = (key: string): string => {
    const value = args[key]

    return typeof value === 'string' ? value : ''
  }

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `${tool} ${clip(text('command'), 60)}`
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${tool} ${tailPath(text('file_path'))}`
    case 'NotebookEdit':
      return `${tool} ${tailPath(text('notebook_path'))}`
    case 'Grep':
      return `Grep "${clip(text('pattern'), 40)}"`
    case 'Glob':
      return `Glob ${clip(text('pattern'), 50)}`
    case 'WebSearch':
      return `WebSearch "${clip(text('query'), 50)}"`
    case 'WebFetch':
      return `WebFetch ${clip(text('url'), 60)}`
    case 'Agent':
      return `Agent ${clip(text('description'), 40)}`
    default:
      return clip(tool.replace(/^mcp__/, ''), 50)
  }
}

export function addUsage(base: AgentBoardTokens | undefined, usage: ModelUsage): AgentBoardTokens {
  return {
    input: (base?.input ?? 0) + usage.input_tokens,
    output: (base?.output ?? 0) + usage.output_tokens,
    cacheRead: (base?.cacheRead ?? 0) + usage.cache_read_input_tokens,
    cacheWrite: (base?.cacheWrite ?? 0) + usage.cache_creation_input_tokens,
  }
}

export function totalTokens(tokens: AgentBoardTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}k`
  }

  return String(count)
}

/** A bar of `width` cells, filled in proportion to `percent`. */
export function fillBar(percent: number, width: number): string {
  const cells = Math.max(1, Math.floor(width))
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

/** The theme color of a fill: calm below 70%, a warning from there, an error from 90%. */
export function fillTone(percent: number): 'success' | 'warning' | 'error' {
  return percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'
}

/** m:ss, or h:mm:ss from an hour. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const ss = String(seconds % 60).padStart(2, '0')

  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${ss}`
  }

  return `${minutes}:${ss}`
}

export function isIdle(row: AgentBoardRow, now: number): boolean {
  return row.status === 'running' && now - row.lastAt > IDLE_MS
}

export function statusIcon(row: AgentBoardRow, now: number): string {
  if (isIdle(row, now)) {
    return '⏸'
  }

  return { running: '●', done: '✓', failed: '✗', stopped: '■' }[row.status]
}

/** "1 step", "3 steps". */
export function stepsText(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`
}

/** What a row is doing now, or what it cost once it ended. */
export function rowNote(row: AgentBoardRow, now: number): string {
  const last = row.lastAction === '' ? '—' : row.lastAction

  switch (row.status) {
    case 'running': {
      const idle = isIdle(row, now) ? `quiet for ${Math.floor((now - row.lastAt) / 60_000)} min · ` : ''

      return `${idle}last: ${last}`
    }
    case 'done':
      return row.tokens === undefined
        ? 'token —'
        : `token ${formatTokens(totalTokens(row.tokens))} (cache read ${formatTokens(row.tokens.cacheRead)})`
    case 'failed':
      return `failed, last step: ${last}`
    case 'stopped':
      return 'stopped'
  }
}

/** The second line of a row: type, steps, and its note. */
export function rowDetail(row: AgentBoardRow, now: number): string {
  return `${row.type} · ${stepsText(row.steps)} · ${rowNote(row, now)}`
}

/** "2 running · 3 ended", with the failed ones when there are any. */
export function summaryText(list: readonly AgentBoardRow[]): string {
  const { running, ended, failed } = countRows(list)

  return `${running} running · ${ended} ended${failed > 0 ? ` · ${failed} failed` : ''}`
}

function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * The board as Markdown: a status file VS Code's Markdown preview shows live (VS Code draws no
 * mod pane), and the text `/agent-board` prints.
 */
export function renderMarkdown(list: readonly AgentBoardRow[], now: number, keep: number, withHeading: boolean): string {
  const lines = withHeading ? ['# Subagents', ''] : []

  // no clock time: the hooks environment's time zone is not the person's
  lines.push(summaryText(list), '')

  if (list.length === 0) {
    lines.push('No subagents in this session yet. Once one starts, this updates by itself.')
  } else {
    lines.push('| State | Subagent | Type | Time | Steps | Last step / token |', '|:-:|---|---|--:|--:|---|')
    for (const row of orderRows(list, keep)) {
      const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)

      lines.push(
        `| ${statusIcon(row, now)} | ${tableCell(row.label)} | ${tableCell(row.type)} | ${elapsed} | ${row.steps} | ${tableCell(rowNote(row, now))} |`,
      )
    }
  }

  lines.push('', 'Key: ● running · ⏸ quiet for over 2 min · ✓ done · ✗ failed · ■ stopped', '')

  return lines.join('\n')
}

/** Running rows in start order, then up to `keep` ended rows, newest first. */
export function orderRows(list: readonly AgentBoardRow[], keep: number): AgentBoardRow[] {
  const ended = list
    .filter(row => row.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.lastAt) - (a.endedAt ?? a.lastAt))

  return [...list.filter(row => row.status === 'running'), ...ended.slice(0, keep)]
}

export function countRows(list: readonly AgentBoardRow[]): { running: number; ended: number; failed: number } {
  const running = list.filter(row => row.status === 'running').length
  const failed = list.filter(row => row.status === 'failed').length

  return { running, ended: list.length - running, failed }
}
