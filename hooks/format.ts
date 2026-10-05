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
  ['five_hour', '5 小時工作階段'],
  ['seven_day', '每週・所有模型'],
  ['seven_day_opus', '每週・Opus'],
  ['seven_day_sonnet', '每週・Sonnet'],
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
        const window = windowOf(`model:${name}`, `每週・${name}`, item)
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

/** What a row is doing now, or what it cost once it ended. */
export function rowNote(row: AgentBoardRow, now: number): string {
  const last = row.lastAction === '' ? '—' : row.lastAction

  switch (row.status) {
    case 'running': {
      const idle = isIdle(row, now) ? `${Math.floor((now - row.lastAt) / 60_000)} 分鐘沒有動靜 · ` : ''

      return `${idle}最近：${last}`
    }
    case 'done':
      return row.tokens === undefined
        ? 'token —'
        : `token ${formatTokens(totalTokens(row.tokens))}（快取讀取 ${formatTokens(row.tokens.cacheRead)}）`
    case 'failed':
      return `失敗，最後一步：${last}`
    case 'stopped':
      return '已中止'
  }
}

/** The second line of a row: type, steps, and its note. */
export function rowDetail(row: AgentBoardRow, now: number): string {
  return `${row.type} · ${row.steps} 步 · ${rowNote(row, now)}`
}

function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * The board as Markdown: a status file VS Code's Markdown preview shows live (VS Code draws no
 * mod pane), and the text `/agent-board` prints.
 */
export function renderMarkdown(list: readonly AgentBoardRow[], now: number, keep: number, withHeading: boolean): string {
  const { running, ended, failed } = countRows(list)
  const lines = withHeading ? ['# 子代理進度', ''] : []

  // no clock time: the hooks environment's time zone is not the person's
  lines.push(`${running} 執行中 · ${ended} 已結束${failed > 0 ? ` · ${failed} 失敗` : ''}`, '')

  if (list.length === 0) {
    lines.push('這個 session 還沒有子代理。派出子代理後，這裡會自動更新。')
  } else {
    lines.push('| 狀態 | 子代理 | 類型 | 時間 | 步數 | 最近一步／token |', '|:-:|---|---|--:|--:|---|')
    for (const row of orderRows(list, keep)) {
      const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)

      lines.push(
        `| ${statusIcon(row, now)} | ${tableCell(row.label)} | ${tableCell(row.type)} | ${elapsed} | ${row.steps} | ${tableCell(rowNote(row, now))} |`,
      )
    }
  }

  lines.push('', '狀態符號：● 執行中　⏸ 超過 2 分鐘沒動靜　✓ 完成　✗ 失敗　■ 中止', '')

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
