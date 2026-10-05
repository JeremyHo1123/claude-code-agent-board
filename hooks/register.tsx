import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { AgentBoardRow, AgentBoardStatus } from '../types'
import {
  addUsage,
  boardRootOf,
  clip,
  countRows,
  describeCall,
  formatElapsed,
  orderRows,
  parsePlanUsage,
  renderMarkdown,
  rowDetail,
  statusIcon,
} from './format'
import type { PlanUsage, SessionActivity } from './format'

/**
 * Where the board's files go, read by the Agent Board VS Code extension: `agent-board` under
 * Claude Code's own folder (CLAUDE_CONFIG_DIR, else ~/.claude). VS Code's Claude extension draws
 * no mod pane (it never attaches as a ui_render surface), so there the board is that extension's
 * webview. Outside every project, so the rewrites never reach a repository.
 *
 * `sessions/<sessionId>.json` is one snapshot per session; `plan.json` the read of the
 * subscription's usage all sessions share. Undefined until first asked; null with no home known.
 */
let boardRoot: string | null | undefined
const PANE = 'agent-board'
const TITLE = '子代理進度'
const TICK_MS = 5_000
const FLUSH_MS = 1_000
const MAX_ROWS = 100
const SHOWN_ENDED = 30
/** Opened unasked once this many subagents run at the same time. */
const AUTO_OPEN_AT = 2

const rows = atom({ plugin: 'agent-board', key: 'rows' } as const, [])
const now = atom({ plugin: 'agent-board', key: 'now' } as const, 0)
const isDismissed = atom({ plugin: 'agent-board', key: 'isDismissed' } as const, false)

/** How `$.agent.list()` statuses map onto a row's, for runs whose turn.complete never came (killed). */
const LIST_STATUS: Readonly<Record<string, AgentBoardStatus>> = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

/**
 * The subscription's usage, from the endpoint Claude Code's /usage reads. The session's credential
 * rides through `$.session.authorize()`: the host sets the header, the secret never reaches here.
 */
const PLAN_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/**
 * Every session shares one read through this file (under the board's folder): whichever finds it
 * due claims it, reads, and writes the answer back. One read per interval however many Claude tabs
 * are open; each session polling on its own got the endpoint to refuse most of them.
 */
const PLAN_FILE = 'plan.json'
/** One read across all sessions this often; while Claude works, each API response's own readings are fresher. */
const PLAN_INTERVAL_MS = 30_000
/**
 * After a refusal without Retry-After, or any other failure, nobody asks again for this long,
 * doubled for each failure in a row up to the cap; a success starts it over.
 */
const PLAN_BACKOFF_MS = 60_000
const PLAN_BACKOFF_MAX_MS = 600_000
/** How often a session looks at the shared file. */
const PLAN_CHECK_MS = 5_000
/** An idle session rewrites its snapshot this often, so the board can tell it from a closed one. */
const HEARTBEAT_MS = 60_000

type SharedPlan = {
  plan?: PlanUsage
  /** No session reads before this time: the next interval, or a backoff after a failure. */
  nextAttemptAt: number
  lastAttemptAt?: number
  lastError?: { at: number; status?: number; message?: string }
  /** Failed reads in a row: each one doubles the wait. */
  failures?: number
}

/** Set by frequent events (tool calls, main turns); the flush timer writes the snapshot at most once a second. */
let isDirty = false
let isFlushing = false
let planCheckedAt = 0
/** When this session last saw an API response arrive (a tool call follows one): how fresh its rate-limit readings are. */
let lastResponseAt = 0
/** Module state, as the board reads it: a reload starts it over as idle, the next turn corrects it. */
let activity: SessionActivity = { state: 'idle', since: Date.now() }

function setActivity(state: SessionActivity['state'], wait?: { reason: string; kind: 'question' | 'permission' }): void {
  if (activity.state === state && activity.reason === wait?.reason) {
    return
  }
  activity = wait === undefined ? { state, since: Date.now() } : { state, since: Date.now(), ...wait }
  isDirty = true
}

/** A permission dialog was answered once the next step starts or the approved tool returns. */
function endPermissionWait(): void {
  if (activity.state === 'waiting' && activity.kind === 'permission') {
    setActivity('working')
  }
}

function freshRow(id: string, at: number): AgentBoardRow {
  return {
    id,
    label: `未具名代理 ${id.slice(0, 7)}`,
    type: '其他（workflow 等）',
    isListed: false,
    status: 'running',
    startedAt: at,
    lastAt: at,
    steps: 0,
    lastAction: '',
  }
}

function asRunning(row: AgentBoardRow): AgentBoardRow {
  const { endedAt: _endedAt, ...rest } = row

  return { ...rest, status: 'running' }
}

/** Applies `change` to the row of `id` (made first when `create`), stamping it with the time. */
async function upsert(
  $: EngineInterface,
  id: string,
  change: (row: AgentBoardRow, at: number) => AgentBoardRow,
  create: boolean,
): Promise<void> {
  const at = await $.clock.now()

  await update($, rows, list => {
    const found = list.find(row => row.id === id)

    if (found === undefined && !create) {
      return list
    }

    const changed = change({ ...(found ?? freshRow(id, at)), lastAt: at }, at)

    return found === undefined
      ? [...list, changed].slice(-MAX_ROWS)
      : list.map(row => (row.id === id ? changed : row))
  })
  await update($, now, () => at)
}

/**
 * A file of the board's, by its path under the board's folder. The home folder comes from the
 * environment (the hooks environment has no `os`): USERPROFILE on Windows, HOME elsewhere.
 * Rejects where neither is set: a caller's own catch leaves that file unwritten.
 */
async function boardPath($: EngineInterface, name: string): Promise<string> {
  if (boardRoot === undefined) {
    boardRoot =
      boardRootOf(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('USERPROFILE'), await $.env.get('HOME')) ?? null
  }
  if (boardRoot === null) {
    throw new Error('agent-board: no home folder to keep the board in')
  }

  return `${boardRoot}/${name}`
}

async function readSharedPlan($: EngineInterface): Promise<SharedPlan | undefined> {
  try {
    return JSON.parse(await $.fs.read(await boardPath($, PLAN_FILE))) as SharedPlan
  } catch {
    return undefined
  }
}

/** One read of the endpoint: the windows, or the failure and how long everyone should wait. */
async function fetchPlan($: EngineInterface, at: number, failuresBefore: number): Promise<Partial<SharedPlan>> {
  const failures = failuresBefore + 1
  const backoff = Math.min(PLAN_BACKOFF_MS * 2 ** (failures - 1), PLAN_BACKOFF_MAX_MS)
  const failed = (lastError: NonNullable<SharedPlan['lastError']>, wait = backoff): Partial<SharedPlan> => ({
    lastError,
    nextAttemptAt: at + wait,
    failures,
  })
  try {
    const auth = await $.session.authorize()
    if (auth === null || auth.kind !== 'bearer') {
      // an API key or a third-party provider: no subscription windows to read
      return failed({ at, message: '沒有訂閱帳號的憑證' })
    }
    const response = await $.http.fetch(PLAN_USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    })
    if (!response.ok) {
      const retryAfter = Number(response.headers['retry-after'])
      const isTold = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0

      return failed({ at, status: response.status }, isTold ? Math.max(retryAfter * 1000, PLAN_INTERVAL_MS) : backoff)
    }
    const parsed = parsePlanUsage(JSON.parse(response.text), at)
    if (parsed === undefined) {
      return failed({ at, message: '回應的格式讀不懂' })
    }

    // a success clears the error and the streak: JSON drops an undefined field
    return { plan: parsed, lastError: undefined, failures: undefined }
  } catch (error) {
    return failed({ at, message: String(error).slice(0, 160) })
  }
}

/** Reads the subscription's usage when the shared file says it is due, claiming the read first. */
async function maybeReadPlan($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  if (at - planCheckedAt < PLAN_CHECK_MS) {
    return
  }
  planCheckedAt = at

  const shared = await readSharedPlan($)
  if (shared !== undefined && at < shared.nextAttemptAt) {
    return
  }

  // claimed before the request, so another session checking now skips this round
  const file = await boardPath($, PLAN_FILE)
  const claimed: SharedPlan = { ...shared, nextAttemptAt: at + PLAN_INTERVAL_MS, lastAttemptAt: at }
  await $.fs.write(file, JSON.stringify(claimed))
  const outcome = await fetchPlan($, at, shared?.failures ?? 0)
  await $.fs.write(file, JSON.stringify({ ...claimed, ...outcome }))
}

/** Once a second: read the shared plan usage when it is due, then write the snapshot when anything changed. */
async function flush($: EngineInterface): Promise<void> {
  if (isFlushing) {
    return
  }
  isFlushing = true
  try {
    await maybeReadPlan($).catch(() => undefined)
    if (isDirty) {
      isDirty = false
      await writeSnapshot($)
    }
  } finally {
    isFlushing = false
  }
}

/** Writes this session's snapshot; a failed write leaves the previous one for the extension. */
async function writeSnapshot($: EngineInterface, ending?: { sessionId: string }): Promise<void> {
  try {
    const list = await read($, rows)
    const at = Math.max(await $.clock.now(), ...list.map(row => row.lastAt))
    const sessionId = ending?.sessionId ?? (await $.session.id())
    // `summary` is /context's own figure: the last response's usage plus a local estimate of what
    // came after it (tool results, the new prompt), so the meter does not trail a step behind
    const [cwd, model, usage] = await Promise.all([
      $.session.cwd(),
      $.session.model(),
      $.session
        .usage({ breakdown: 'summary', columns: 40 })
        .catch(() => $.session.usage())
        .catch(() => undefined),
    ])
    const breakdown = usage?.context.breakdown
    const snapshot = {
      version: 1,
      sessionId,
      cwd,
      model,
      updatedAt: at,
      isClosed: ending !== undefined,
      usage:
        usage === undefined
          ? undefined
          : {
              contextPercent: breakdown?.percentage ?? usage.context.percent,
              contextTokens: breakdown?.totalTokens ?? usage.context.tokens,
              contextWindow: breakdown?.rawMaxTokens ?? usage.context.window,
              isContextEstimate: breakdown !== undefined,
              rateLimits: usage.rateLimits.map(limit => ({
                kind: limit.kind,
                percentUsed: limit.percentUsed,
                resetsAt: limit.resetsAt,
              })),
              // the readings are as fresh as the last response this session saw
              rateLimitsAt: usage.rateLimits.length > 0 && lastResponseAt > 0 ? lastResponseAt : undefined,
            },
      activity,
      agents: list,
    }

    await $.fs.write(await boardPath($, `sessions/${sessionId}.json`), JSON.stringify(snapshot))
  } catch {
    // the terminal pane, where there is one, still stands
  }
}

async function refreshStatusLine($: EngineInterface): Promise<void> {
  const { running, ended } = countRows(await read($, rows))

  $.ui.status(running === 0 ? undefined : `子代理 ${running} 執行中 · ${ended} 已結束 — /agent-board`)
}

async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (await read($, isDismissed)) {
    return
  }
  if (countRows(await read($, rows)).running >= AUTO_OPEN_AT) {
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  }
}

/** Every few seconds while something runs: move the clock the pane draws from, settle killed runs. */
async function tick($: EngineInterface): Promise<void> {
  const list = await read($, rows)

  if (!list.some(row => row.status === 'running')) {
    return
  }

  let listed: readonly AgentInfo[] = []
  try {
    listed = await $.agent.list()
  } catch {
    listed = []
  }

  const at = await $.clock.now()
  const settled = new Map<string, AgentBoardStatus>()
  for (const info of listed) {
    const status = LIST_STATUS[info.status]
    if (status !== undefined) {
      settled.set(info.id, status)
    }
  }

  if (settled.size > 0) {
    await update($, rows, current =>
      current.map(row => {
        const status = row.isListed && row.status === 'running' ? settled.get(row.id) : undefined

        return status === undefined ? row : { ...row, status, endedAt: row.endedAt ?? at }
      }),
    )
  }
  await update($, now, () => at)
  await refreshStatusLine($)
  isDirty = false
  await writeSnapshot($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-board',
      description: '子代理進度：每個子代理的狀態、步數、最近一步、時間與 token',
      immediate: true,
    })
    $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })
    $.clock.every(FLUSH_MS, () => {
      void flush($).catch(() => undefined)
    })
    $.clock.every(HEARTBEAT_MS, () => {
      // an idle session's snapshot stays young, so the board can tell it from a closed one
      isDirty = true
    })
    await writeSnapshot($)

    return next(e)
  })

  // Pushed by the engine after each main-thread turn and whenever a rate-limit window moves a whole
  // point: the usage meters follow it without polling (the idea comes from Learning Hacker's working-memory mod).
  on('session.measure', async ($, e, next) => {
    isDirty = true
    lastResponseAt = Date.now()

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await writeSnapshot($, { sessionId: e.sessionId })
    if (e.reason === 'clear') {
      // the process goes on under a new session id: its board starts empty
      await update($, rows, () => [])
    }

    return next(e)
  })

  on('command.run', { command: 'agent-board' }, async $ => {
    const at = await $.clock.now()
    await update($, now, () => at)
    await update($, isDismissed, () => false)

    // Draws the pane in a terminal; VS Code draws nothing for it, hence the text and the extension.
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    await writeSnapshot($)

    const list = await read($, rows)
    const board = renderMarkdown(list, Math.max(at, ...list.map(row => row.lastAt)), SHOWN_ENDED, false)

    return {
      text: `${board}\n圖形面板：VS Code 左側活動列的 Agent Board 圖示，或 Ctrl+Shift+P →「Agent Board: 打開子代理面板」。`,
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId

    if (id !== undefined) {
      const label = clip(e.description === '' ? e.subagentType : e.description, 60)

      await upsert(
        $,
        id,
        row => ({
          ...asRunning(row),
          label,
          type: e.subagentType,
          isListed: true,
          lastAction: row.lastAction === '' ? '啟動中' : row.lastAction,
        }),
        true,
      )
      await refreshStatusLine($)
      await maybeAutoOpen($)
      await writeSnapshot($)
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    endPermissionWait()

    // a tool call follows a fresh API response: its rate-limit readings are as of now
    lastResponseAt = Date.now()

    if (id === undefined) {
      isDirty = true

      if (String(e.tool) === 'AskUserQuestion') {
        setActivity('waiting', { reason: '問你問題', kind: 'question' })
        try {
          return await next(e)
        } finally {
          setActivity('working')
        }
      }

      const result = await next(e)
      endPermissionWait()
      // the tool's result joins the context: the meter follows within a second
      isDirty = true

      return result
    }

    const action = describeCall(e as unknown as Readonly<Record<string, unknown>>)

    await upsert($, id, row => ({ ...asRunning(row), steps: row.steps + 1, lastAction: action }), true)
    await refreshStatusLine($)
    isDirty = true

    const result = await next(e)
    endPermissionWait()

    return result
  })

  on('turn.start', async ($, e, next) => {
    setActivity('working')

    return next(e)
  })

  // Raised just before a permission dialog opens (the classic PermissionRequest hook's moment).
  on('classic.PermissionRequest', async ($, e, next) => {
    setActivity('waiting', { reason: `等你允許 ${e.tool_name}`, kind: 'permission' })

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    endPermissionWait()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId

    if (id === undefined) {
      // a main-loop turn moved the context window and the rate limits, and the session now waits for a prompt
      isDirty = true
      lastResponseAt = Date.now()
      setActivity('idle')

      return result
    }

    const status: AgentBoardStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
    const usage = e.usage

    await upsert(
      $,
      id,
      (row, at) => ({
        ...row,
        status,
        endedAt: at,
        ...(usage === undefined ? {} : { tokens: addUsage(row.tokens, usage) }),
      }),
      false,
    )
    await refreshStatusLine($)
    await writeSnapshot($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const at = Math.max(await read($, now), ...list.map(row => row.lastAt))
    const { running, ended, failed } = countRows(list)
    const summary = `${running} 執行中 · ${ended} 已結束${failed > 0 ? ` · ${failed} 失敗` : ''}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{summary}</Text>
          {ended > 0 && (
            <Button
              key="clear"
              label="清除已結束"
              dimColor
              onPress={async () => {
                await update($, rows, current => current.filter(row => row.status === 'running'))
                await writeSnapshot($)
              }}
            />
          )}
        </Box>
        {list.length === 0 && (
          <Text dimColor>這個 session 還沒有子代理。派出子代理後，這裡會即時顯示它們的進度。</Text>
        )}
        {orderRows(list, SHOWN_ENDED).map(row => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold={row.status === 'running'} wrap="truncate-end">
                {`${statusIcon(row, at)} ${row.label}`}
              </Text>
              <Text dimColor>{formatElapsed((row.endedAt ?? at) - row.startedAt)}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {rowDetail(row, at)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
