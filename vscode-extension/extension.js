'use strict'

// Agent Board: draws the subagents of every running Claude Code session in a webview.
// The data comes from the agent-board mod, which writes one JSON snapshot per session
// into ~/.claude/agent-board/sessions (VS Code's Claude extension draws no mod pane).

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vscode = require('vscode')

const POLL_MS = 1_000
/** An open session is listed while its snapshot is younger than this. */
const KEEP_OPEN_MS = 12 * 3_600_000
/** A closed session that had subagents lingers this long. */
const KEEP_CLOSED_MS = 10 * 60_000
/** Snapshots older than this are deleted at startup. */
const PRUNE_MS = 7 * 24 * 3_600_000
const AUTO_REVEAL_AT = 2

/** Claude Code's own folder: CLAUDE_CONFIG_DIR where that is set, else ~/.claude (as the mod resolves it). */
function claudeDirectory() {
  const configured = process.env.CLAUDE_CONFIG_DIR

  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : path.join(os.homedir(), '.claude')
}

function dataDirectory() {
  const configured = vscode.workspace.getConfiguration('agentBoard').get('dataDirectory')

  return typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : path.join(claudeDirectory(), 'agent-board', 'sessions')
}

function isSnapshot(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.sessionId === 'string' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.agents)
  )
}

const LIMIT_LABEL = { five_hour: '5 小時工作階段', seven_day: '每週・所有模型', spend_limit: '花費上限' }
const WINDOW_ORDER = ['five_hour', 'seven_day']
/** A titled transcript is re-read this seldom (a rename shows by then); an untitled one sooner, as its title comes after the first turn. */
const TITLE_RECHECK_MS = 60_000
const TITLE_SEEK_MS = 20_000
/** A first read takes the transcript's tail: Claude Code re-appends the title row every few turns. */
const TITLE_TAIL_BYTES = 1_048_576
/** Later reads take only what was appended, from a little before, for a row the last read caught half-written. */
const TITLE_OVERLAP_BYTES = 65_536

function isoOf(value) {
  const at = Date.parse(value)

  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
}

/** With no claude.ai read to stand on, replies older than this before the latest one are left out. */
const READING_HORIZON_MS = 10 * 60_000

/**
 * One window's figure out of every reading of it, from both sources: claude.ai's own answer (the
 * shared read) and what the API replies carried to each session.
 *
 * A reply's figure is as of before its own request was counted, and knows nothing of what the
 * other sessions spent since: it runs behind. Use within a window only grows, so the highest
 * reading is the latest truth, not the newest one. Which window is in force is another matter:
 * the latest reading that names one decides, so after a reset or a change of account the earlier
 * window's readings fall away at once.
 */
function settleWindow(key, all) {
  const latestFirst = [...all].sort((a, b) => b.at - a.at)
  const asked = latestFirst.find(reading => reading.source === 'plan')
  // claude.ai's answer stands for everything before it: only a later reply can add to it
  const current =
    asked === undefined
      ? latestFirst.filter(reading => reading.at >= latestFirst[0].at - READING_HORIZON_MS)
      : latestFirst.filter(reading => reading === asked || reading.at > asked.at)
  const anchor = current.find(reading => reading.resetsAt !== undefined)
  const inWindow =
    anchor === undefined
      ? current
      : current.filter(reading =>
          reading.resetsAt === undefined
            ? // a reply that names no window is taken for the one in force; claude.ai naming none said there was none
              reading.source === 'response'
            : isSameReset(reading.resetsAt, anchor.resetsAt),
        )
  const best = inWindow.reduce((top, reading) =>
    reading.percent > top.percent || (reading.percent === top.percent && reading.at > top.at) ? reading : top,
  )
  const named = all.find(reading => reading.label !== undefined)

  return {
    key,
    label: named ? named.label : LIMIT_LABEL[key] || key,
    percent: best.percent,
    resetsAt: best.resetsAt || (anchor && anchor.resetsAt),
    at: best.at,
    source: best.source,
  }
}

/**
 * The subscription's windows, settled from the shared claude.ai read (plan.json, one for all
 * sessions) and the rate-limit readings the API replies carried to each session.
 */
function mergeUsage(sessions, shared) {
  /** key -> every reading of that window */
  const readings = new Map()
  const add = reading => {
    const known = readings.get(reading.key)
    if (known === undefined) {
      readings.set(reading.key, [reading])
    } else {
      known.push(reading)
    }
  }
  /** The freshest claude.ai read: the source of the extra-usage line. */
  let plan
  const takePlan = candidate => {
    if (!candidate || !Array.isArray(candidate.windows) || typeof candidate.fetchedAt !== 'number') {
      return
    }
    if (plan === undefined || candidate.fetchedAt > plan.fetchedAt) {
      plan = candidate
    }
    for (const window of candidate.windows) {
      add({
        key: window.key,
        label: window.label,
        percent: window.percent,
        resetsAt: isoOf(window.resetsAt),
        at: candidate.fetchedAt,
        source: 'plan',
      })
    }
  }
  takePlan(shared && shared.plan)
  // a session still on the previous mod reads for itself, into its own snapshot: a source too, until it reloads
  for (const session of sessions) {
    takePlan(session.plan)
  }
  for (const session of sessions) {
    const usage = session.usage
    if (!usage || !Array.isArray(usage.rateLimits) || typeof usage.rateLimitsAt !== 'number') {
      continue
    }
    for (const reading of usage.rateLimits) {
      add({
        key: reading.kind,
        percent: reading.percentUsed,
        resetsAt: isoOf(reading.resetsAt),
        at: usage.rateLimitsAt,
        source: 'response',
      })
    }
  }
  const rank = key => {
    const index = WINDOW_ORDER.indexOf(key)

    return index < 0 ? WINDOW_ORDER.length : index
  }

  return {
    // a stable sort: the 5-hour and weekly windows first, the rest in the plan's own order
    list: [...readings].map(([key, all]) => settleWindow(key, all)).sort((a, b) => rank(a.key) - rank(b.key)),
    extra: plan ? plan.extra : undefined,
    planAt: plan ? plan.fetchedAt : undefined,
    // present only while the last read failed: a success clears it
    planError: shared && shared.lastError ? shared.lastError : undefined,
    planNextAt: shared && typeof shared.nextAttemptAt === 'number' ? shared.nextAttemptAt : undefined,
  }
}

const SOURCE_LABEL = { plan: '查詢', response: '回應' }

/** Why the shared claude.ai read is behind, and when it is tried again; undefined while it works. */
function planProblem(usage, now) {
  const error = usage.planError
  if (!error) {
    return undefined
  }
  const what =
    error.status === 429
      ? '被限流（HTTP 429）'
      : error.status
        ? `失敗（HTTP ${error.status}）`
        : `失敗：${error.message || '原因不明'}`
  const retry = usage.planNextAt !== undefined && usage.planNextAt > now ? `，${inText(usage.planNextAt - now)}再試` : ''

  return `claude.ai 用量查詢${what}${retry}`
}

/** A session's context window as the mod measured it: /context's own estimate where it had one. */
function contextOf(session) {
  const usage = session && session.usage
  if (!usage || typeof usage.contextWindow !== 'number' || usage.contextWindow <= 0) {
    return undefined
  }
  const tokens = typeof usage.contextTokens === 'number' ? usage.contextTokens : 0

  return {
    percent: typeof usage.contextPercent === 'number' ? usage.contextPercent : (tokens / usage.contextWindow) * 100,
    tokens,
    window: usage.contextWindow,
    isEstimate: usage.isContextEstimate === true,
  }
}

function formatTokens(count) {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }

  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count)
}

/** Two readings of one window: its reset moves by no more than a few minutes between reads. */
function isSameReset(a, b) {
  return a === b || (a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) < 10 * 60_000)
}

/** The titles Claude Code wrote into a stretch of transcript: the last whole custom-title and ai-title rows. */
function titlesIn(buffer) {
  const found = {}
  for (const [key, marker, field] of [
    ['custom', '"type":"custom-title"', 'customTitle'],
    ['ai', '"type":"ai-title"', 'aiTitle'],
  ]) {
    const needle = Buffer.from(marker)
    let index = buffer.lastIndexOf(needle)
    while (index >= 0) {
      const start = buffer.lastIndexOf(0x0a, index) + 1
      const newline = buffer.indexOf(0x0a, index)
      try {
        const row = JSON.parse(buffer.subarray(start, newline < 0 ? buffer.length : newline).toString('utf8'))
        if (typeof row[field] === 'string' && row[field].trim() !== '') {
          found[key] = row[field]
          break
        }
      } catch {
        // a row caught mid-write, or cut by the stretch's start: an earlier one stands in
      }
      index = start > 0 ? buffer.lastIndexOf(needle, start - 1) : -1
    }
  }

  return found
}

/**
 * The label VS Code's Claude extension gives a conversation's tab: the title, cut to 24 characters
 * and an ellipsis past 25 (its webview's own rule); "Claude Code" before there is one.
 */
function tabLabelOf(title) {
  return title.length > 25 ? `${title.substring(0, 24)}…` : title
}

/** A Claude conversation tab, as VS Code's tab API sees the extension's webview panel. */
function isClaudeTab(tab) {
  const input = tab && tab.input

  return Boolean(input && typeof input.viewType === 'string' && input.viewType.includes('claudeVSCodePanel'))
}

async function readRange(file, from, to) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)

    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** A session's transcript, wherever its project folder is: ~/.claude/projects/<project>/<sessionId>.jsonl. */
async function findTranscript(sessionId) {
  const root = path.join(claudeDirectory(), 'projects')
  let folders = []
  try {
    folders = await fs.promises.readdir(root)
  } catch {
    return undefined
  }
  for (const folder of folders) {
    const file = path.join(root, folder, `${sessionId}.jsonl`)
    try {
      await fs.promises.access(file)

      return file
    } catch {
      // not in this project
    }
  }

  return undefined
}

// ── an agent's task in detail: its transcript, and the workflow run it belongs to ──

/** What a detail carries: the sidebar's figures are clipped tighter than an editor panel's. */
const DETAIL_LIMITS = {
  sidebar: { prompt: 12_000, text: 2_000, input: 1_500, result: 1_500, output: 20_000, events: 300 },
  panel: { prompt: 80_000, text: 12_000, input: 10_000, result: 10_000, output: 100_000, events: 3_000 },
}
/** A transcript past this is read in part: its head (the task it was given) and its tail (the latest steps). */
const TRANSCRIPT_READ_MAX = 8 * 1_048_576
const TRANSCRIPT_HEAD_BYTES = 262_144
/** Workflow runs saved longer ago than this are left out of the labels. */
const WORKFLOW_FRESH_MS = 24 * 3_600_000
/** How often a session's workflow folder is looked at. */
const WORKFLOW_SCAN_MS = 5_000

/**
 * Where Claude Code keeps an agent's transcript, beside its session's: <session>/subagents/
 * agent-<id>.jsonl, or under a subfolder of that, as a workflow's agents are
 * (<session>/subagents/workflows/<runId>/agent-<id>.jsonl).
 */
async function findAgentTranscript(sessionTranscript, agentId) {
  const name = `agent-${agentId}.jsonl`
  let folders = [path.join(sessionTranscript.replace(/\.jsonl$/i, ''), 'subagents')]
  for (let depth = 0; depth < 3 && folders.length > 0; depth += 1) {
    const next = []
    for (const folder of folders) {
      let entries = []
      try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === name) {
          return path.join(folder, name)
        }
        if (entry.isDirectory()) {
          next.push(path.join(folder, entry.name))
        }
      }
    }
    folders = next
  }

  return undefined
}

async function readTranscriptText(file, size) {
  if (size <= TRANSCRIPT_READ_MAX) {
    return { text: (await fs.promises.readFile(file)).toString('utf8'), truncated: false }
  }
  // whole rows only: the head up to its last newline, the tail from after its first
  const head = await readRange(file, 0, TRANSCRIPT_HEAD_BYTES)
  const tail = await readRange(file, size - (TRANSCRIPT_READ_MAX - TRANSCRIPT_HEAD_BYTES), size)

  return {
    text: head.subarray(0, head.lastIndexOf(0x0a) + 1).toString('utf8') + tail.subarray(tail.indexOf(0x0a) + 1).toString('utf8'),
    truncated: true,
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

function clipTo(text, max) {
  const value = String(text)

  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** A message's text: a string as it is, an array of blocks as their text, an image as a mark. */
function contentText(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => (block && block.type === 'text' ? block.text : block && block.type === 'image' ? '［圖片］' : ''))
    .filter(Boolean)
    .join('\n')
}

function tailPath(file) {
  const parts = String(file || '')
    .split(/[\\/]+/)
    .filter(Boolean)

  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/')
}

/** A step's one-line gist: the file, pattern, command or address it acts on. */
function stepSummary(name, input) {
  const value = input && typeof input === 'object' ? input : {}
  const pick = (...keys) => {
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key].trim() !== '') {
        return value[key].trim()
      }
    }

    return ''
  }
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return tailPath(pick('file_path', 'notebook_path'))
    case 'Grep':
      return `${pick('pattern')}${typeof value.path === 'string' ? ` · ${tailPath(value.path)}` : ''}`
    case 'Glob':
      return pick('pattern')
    case 'Bash':
    case 'PowerShell':
      return pick('description', 'command').replace(/\s+/g, ' ')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
    case 'ToolSearch':
      return pick('query')
    case 'Agent':
    case 'Task':
      return pick('description', 'prompt')
    case 'Skill':
      return pick('skill')
    default: {
      const first = Object.values(value).find(field => typeof field === 'string' && field.trim() !== '')

      return first === undefined ? '' : first.replace(/\s+/g, ' ')
    }
  }
}

/** A step's input as a person reads it: a shell command as itself, anything else as JSON. */
function stepInput(name, input) {
  if (!input || typeof input !== 'object') {
    return ''
  }
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return input.command
  }

  return JSON.stringify(input, null, 2)
}

/**
 * An agent's transcript as its detail shows it: the task it was given, every tool call with its
 * input, result and timing, what it said between them, how it ended, and the tokens it took.
 *
 * Its rows: the first user row is the task; an assistant reply comes as one row per content block
 * (a thinking row, a text row, a tool_use row), each carrying the reply's usage as it stood (the
 * last one's whole), so usage is counted once per request at its largest; a tool's result comes in
 * a user row's tool_result block. A subagent hands its report back through SubagentHandback, a
 * workflow's agent through StructuredOutput; an API failure is a synthetic assistant row.
 */
function parseAgentTranscript(text, limits) {
  let prompt
  let model
  let startedAt
  let lastAt
  let failure
  let output
  let lastText
  let thinkingMs = 0
  const events = []
  const steps = new Map()
  const usageByRequest = new Map()

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    let row
    try {
      row = JSON.parse(line)
    } catch {
      // a row cut by a partial read, or caught mid-write
      continue
    }
    if (!row || typeof row !== 'object') {
      continue
    }
    const parsedAt = Date.parse(row.timestamp)
    if (!Number.isNaN(parsedAt)) {
      startedAt = startedAt === undefined ? parsedAt : startedAt
      lastAt = parsedAt
    }
    const at = Number.isNaN(parsedAt) ? lastAt : parsedAt
    const message = row.message
    if (!message || typeof message !== 'object') {
      continue
    }

    if (row.type === 'user') {
      const blocks = Array.isArray(message.content) ? message.content : []
      const results = blocks.filter(block => block && block.type === 'tool_result')
      if (results.length === 0) {
        if (prompt === undefined && !row.isMeta) {
          prompt = contentText(message.content)
        }
        continue
      }
      for (const block of results) {
        const step = steps.get(block.tool_use_id)
        if (step === undefined) {
          continue
        }
        const full = contentText(block.content)
        step.endAt = at
        step.isError = block.is_error === true
        step.result = clipTo(full, limits.result)
        step.resultTotal = full.length
      }
      continue
    }

    if (row.type !== 'assistant') {
      continue
    }
    if (row.isApiErrorMessage) {
      failure = contentText(message.content) || String(row.error || 'API 錯誤')
      continue
    }
    // a later reply means it got past the failure
    failure = undefined
    if (model === undefined && typeof message.model === 'string' && message.model !== '<synthetic>') {
      model = message.model
    }
    if (typeof row.thinkingDurationMs === 'number') {
      thinkingMs += row.thinkingDurationMs
    }
    const usage = message.usage
    if (usage && typeof usage === 'object') {
      const request = row.requestId || message.id || row.uuid
      const known = usageByRequest.get(request)
      if (known === undefined || (usage.output_tokens || 0) >= (known.output_tokens || 0)) {
        usageByRequest.set(request, usage)
      }
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block) {
        continue
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const event = { kind: 'text', at, text: clipTo(block.text.trim(), limits.text) }
        lastText = { text: block.text.trim(), event }
        events.push(event)
      } else if (block.type === 'tool_use') {
        if (block.name === 'SubagentHandback') {
          const full = String((block.input && block.input.message) || '')
          output = { via: 'handback', text: clipTo(full, limits.output), total: full.length }
        } else if (block.name === 'StructuredOutput') {
          const full = JSON.stringify(block.input, null, 2)
          output = { via: 'structured', text: clipTo(full, limits.output), total: full.length }
        } else {
          const step = {
            kind: 'tool',
            id: block.id,
            name: block.name,
            summary: clipTo(stepSummary(block.name, block.input), 300),
            input: clipTo(stepInput(block.name, block.input), limits.input),
            at,
          }
          steps.set(block.id, step)
          events.push(step)
        }
      }
    }
  }

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const counted of usageByRequest.values()) {
    usage.input += counted.input_tokens || 0
    usage.output += counted.output_tokens || 0
    usage.cacheRead += counted.cache_read_input_tokens || 0
    usage.cacheWrite += counted.cache_creation_input_tokens || 0
  }
  const tools = events.filter(event => event.kind === 'tool')
  const dropped = Math.max(0, events.length - limits.events)

  return {
    prompt: prompt === undefined ? undefined : clipTo(prompt, limits.prompt),
    model,
    startedAt,
    lastAt,
    failure,
    output,
    // the last thing it said, when nothing came after it: the answer, once the agent has ended
    finalText:
      lastText !== undefined && events[events.length - 1] === lastText.event
        ? { text: clipTo(lastText.text, limits.output), total: lastText.text.length }
        : undefined,
    events: dropped > 0 ? events.slice(dropped) : events,
    eventsDropped: dropped,
    toolCount: tools.length,
    errorCount: tools.filter(step => step.isError).length,
    usage,
    thinkingMs,
  }
}

/** A task's gist for a name: its first line with words in it, without markdown marks, cut short. */
function firstTaskLine(text) {
  const line = String(text || '')
    .split('\n')
    .map(candidate => candidate.replace(/^[\s#>*\-+\d.)]+/, '').replace(/[*_`]/g, '').trim())
    .find(candidate => candidate !== '')

  return line === undefined ? undefined : clipTo(line, 48)
}

/** A workflow run as the engine saves it (<session>/workflows/<runId>.json): its name, phases and agents. */
function parseWorkflowRun(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.workflowProgress)) {
    return undefined
  }

  return {
    runId: json.runId,
    name: json.workflowName || json.runId || 'workflow',
    summary: json.summary,
    status: json.status,
    phases: Array.isArray(json.phases) ? json.phases.map(phase => ({ title: phase.title, detail: phase.detail })) : [],
    agents: json.workflowProgress
      .filter(entry => entry && entry.type === 'workflow_agent' && typeof entry.agentId === 'string')
      .map(entry => ({
        agentId: entry.agentId,
        label: entry.label,
        phase: entry.phaseTitle,
        state: entry.state,
        model: entry.model,
        startedAt: entry.startedAt,
      })),
  }
}

const WEEKDAY = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

/**
 * When a window resets, worded as claude.ai's usage page words it ("Resets Tue 4:00 AM"), then how
 * long that is from now: "週二 04:00 重置（4 小時 51 分後）".
 */
function resetText(iso, now) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) {
    return ''
  }
  // to the minute: one source says 19:59:59.8, the other 20:00:00
  const date = new Date(Math.round(at / 60_000) * 60_000)
  const pad = value => String(value).padStart(2, '0')
  const minutes = Math.ceil((at - now) / 60_000)
  const hours = Math.floor(minutes / 60)
  const until =
    minutes <= 0
      ? '時間已到'
      : minutes < 60
        ? `${minutes} 分後`
        : hours < 24
          ? `${hours} 小時 ${minutes % 60} 分後`
          : `${Math.floor(hours / 24)} 天 ${hours % 24} 小時後`

  return `${WEEKDAY[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())} 重置（${until}）`
}

function agoText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 5) {
    return '剛剛'
  }

  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分鐘前` : `${Math.floor(seconds / 3600)} 小時前`
}

function inText(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000))

  return seconds < 60 ? `${seconds} 秒後` : seconds < 3600 ? `${Math.ceil(seconds / 60)} 分鐘後` : `${Math.ceil(seconds / 3600)} 小時後`
}

/** A snapshot younger than this is a live session: the mod writes a heartbeat every minute. */
const LIVE_MS = 180_000
/** A wait is news once it has lasted this long: a dialog answered at once is not. */
const WAIT_NOTIFY_MS = 15_000
/** A finished turn is news once it ran this long: the person has likely looked elsewhere. */
const LONG_TURN_MS = 120_000
/** This many subagents finishing at once fold into one notification. */
const BATCH_AT = 3
const USAGE_THRESHOLDS = [80, 90]

function projectOf(cwd) {
  const parts = String(cwd || '')
    .split(/[\\/]+/)
    .filter(Boolean)

  return parts[parts.length - 1] || '對話'
}

/** What a session is called in notifications and the status bar: its title, else its project folder. */
function nameOf(session, max) {
  const name = session.title || projectOf(session.cwd)

  return max !== undefined && name.length > max ? `${name.substring(0, max - 1)}…` : name
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`
    : minutes > 0
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`
}

const isLive = (session, now) => !session.isClosed && now - session.updatedAt < LIVE_MS

class AgentBoard {
  constructor(context) {
    this.context = context
    /** path -> { mtimeMs, snapshot } */
    this.files = new Map()
    this.view = undefined
    this.lastPayload = ''
    this.runningBefore = 0
    /** The last poll's sessions and agents, keyed; undefined until the first poll, which is only a baseline. */
    this.baseline = undefined
    /** `sessionKey@since` of waits already announced. */
    this.waitNotified = new Set()
    /** Per usage window: the highest threshold crossed, and the reset it belongs to. */
    this.usageLevels = new Map()
    /** The shared claude.ai read (plan.json) and the mtime it was read at. */
    this.shared = undefined
    this.sharedMtime = 0
    /** sessionId -> { path, size, custom, ai, isScanned, checkedAt, soughtAt }: each session's titles, from its transcript. */
    this.titles = new Map()
    /** The session whose Claude tab was last focused, matched by its label. */
    this.focusedSessionId = undefined
    /** With no tab matched: the session the context meter settled on, kept while it lives. */
    this.pickedSessionId = undefined
    this.usage = { list: [] }
    /** Workflow run files: path -> { mtimeMs, run }; and per session, agentId -> the run's word on that agent. */
    this.workflowRuns = new Map()
    this.workflowAgents = new Map()
    this.workflowScannedAt = new Map()
    /**
     * The details someone is looking at, kept current: key -> { sessionId, agentId, mode, post, path,
     * parsedSize, transcript, meta, signature }. The sidebar's is keyed 'view'; each panel by its agent.
     */
    this.watches = new Map()
    /** sessionId:agentId -> the editor panel showing that agent. */
    this.panels = new Map()
    /**
     * Agents the mod knows only by id (a workflow's, before its run file is written at the end),
     * named for now by their task's first line: agentId -> { label, isWorkflow }.
     */
    this.provisional = new Map()
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
    this.status.command = 'agentBoard.open'
    this.usageItem = vscode.window.createStatusBarItem('agentBoard.usage', vscode.StatusBarAlignment.Right, 100)
    this.usageItem.name = 'Agent Board：訂閱用量'
    this.usageItem.command = 'agentBoard.open'
    // The current conversation's context, just left of the usage: the nearest place to the Claude
    // tab's prompt this extension can draw in (that tab's own webview takes nothing from outside).
    this.contextItem = vscode.window.createStatusBarItem('agentBoard.context', vscode.StatusBarAlignment.Right, 101)
    this.contextItem.name = 'Agent Board：目前對話的上下文'
    this.contextItem.command = 'agentBoard.open'
    context.subscriptions.push(this.status, this.usageItem, this.contextItem)
  }

  async prune() {
    const dir = dataDirectory()
    let names = []
    try {
      names = await fs.promises.readdir(dir)
    } catch {
      return
    }
    const cutoff = Date.now() - PRUNE_MS
    await Promise.all(
      names
        .filter(name => name.endsWith('.json'))
        .map(async name => {
          const file = path.join(dir, name)
          try {
            const stat = await fs.promises.stat(file)
            if (stat.mtimeMs < cutoff) {
              await fs.promises.unlink(file)
            }
          } catch {
            // gone already, or held open by a writer: next startup tries again
          }
        }),
    )
  }

  async poll() {
    const dir = dataDirectory()
    let names = []
    try {
      names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.json'))
    } catch {
      names = []
    }

    const seen = new Set()
    for (const name of names) {
      const file = path.join(dir, name)
      seen.add(file)
      let stat
      try {
        stat = await fs.promises.stat(file)
      } catch {
        continue
      }
      const cached = this.files.get(file)
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
        continue
      }
      try {
        const snapshot = JSON.parse(await fs.promises.readFile(file, 'utf8'))
        if (isSnapshot(snapshot)) {
          this.files.set(file, { mtimeMs: stat.mtimeMs, snapshot })
        }
      } catch {
        // caught mid-write: the previous read stands until the next poll
      }
    }
    for (const file of [...this.files.keys()]) {
      if (!seen.has(file)) {
        this.files.delete(file)
      }
    }

    const sessions = this.sessions()
    await this.readShared()
    await this.refreshTitles(sessions)
    await this.refreshWorkflows(sessions)
    await this.nameUnnamed(sessions)
    this.updateFocus(sessions)
    this.publish()
    await this.refreshDetails()
  }

  /**
   * A name for each agent the mod knows only by id, from its transcript's first row (the task it
   * was given): a workflow writes its agents' labels only when the run ends. Four reads a poll.
   */
  async nameUnnamed(sessions) {
    let reads = 0
    for (const session of sessions) {
      const runs = this.workflowAgents.get(session.sessionId)
      for (const agent of session.agents) {
        if (agent.isListed || this.provisional.has(agent.id) || (runs && runs.has(agent.id)) || reads >= 4) {
          continue
        }
        const transcript = await this.sessionTranscript(session.sessionId)
        const file = transcript === undefined ? undefined : await findAgentTranscript(transcript, agent.id)
        if (file === undefined) {
          // not written yet: the next poll looks again
          continue
        }
        reads += 1
        let label
        try {
          const head = await readRange(file, 0, 65_536)
          const end = head.indexOf(0x0a)
          const row = JSON.parse(head.subarray(0, end < 0 ? head.length : end).toString('utf8'))
          label = firstTaskLine(contentText(row.message && row.message.content))
        } catch {
          // a first row longer than the read: the mod's own name stands
        }
        this.provisional.set(agent.id, { label, isWorkflow: /[\\/]workflows[\\/]/.test(file) })
      }
    }
  }

  /** A session's own transcript: from the titles' cache, else found once and kept. */
  async sessionTranscript(sessionId) {
    const entry = this.titles.get(sessionId)
    if (entry !== undefined && entry.path !== undefined) {
      return entry.path
    }
    if (this.transcriptPaths === undefined) {
      this.transcriptPaths = new Map()
    }
    if (!this.transcriptPaths.has(sessionId)) {
      const found = await findTranscript(sessionId)
      if (found === undefined) {
        return undefined
      }
      this.transcriptPaths.set(sessionId, found)
    }

    return this.transcriptPaths.get(sessionId)
  }

  /**
   * Each session's workflow runs (<session>/workflows/<runId>.json), read when they change: their
   * names and phases label the agents the mod only knows by id.
   */
  async refreshWorkflows(sessions) {
    const now = Date.now()
    for (const session of sessions) {
      if (session.isClosed && session.agents.length === 0) {
        continue
      }
      if (now - (this.workflowScannedAt.get(session.sessionId) || 0) < WORKFLOW_SCAN_MS) {
        continue
      }
      this.workflowScannedAt.set(session.sessionId, now)
      const transcript = await this.sessionTranscript(session.sessionId)
      if (transcript === undefined) {
        continue
      }
      const folder = path.join(transcript.replace(/\.jsonl$/i, ''), 'workflows')
      let names = []
      try {
        names = (await fs.promises.readdir(folder)).filter(name => name.endsWith('.json'))
      } catch {
        continue
      }
      const agents = new Map()
      for (const name of names) {
        const file = path.join(folder, name)
        let stat
        try {
          stat = await fs.promises.stat(file)
        } catch {
          continue
        }
        if (now - stat.mtimeMs > WORKFLOW_FRESH_MS) {
          continue
        }
        let cached = this.workflowRuns.get(file)
        if (cached === undefined || cached.mtimeMs !== stat.mtimeMs) {
          const run = parseWorkflowRun(await readJson(file))
          if (run === undefined) {
            continue
          }
          cached = { mtimeMs: stat.mtimeMs, run }
          this.workflowRuns.set(file, cached)
        }
        for (const agent of cached.run.agents) {
          agents.set(agent.agentId, { ...agent, runId: cached.run.runId, name: cached.run.name })
        }
      }
      this.workflowAgents.set(session.sessionId, agents)
    }
  }

  /** An agent row with what its workflow run says of it: the label the mod lacks, the run and phase. */
  withWorkflow(sessionId, agent) {
    const runs = this.workflowAgents.get(sessionId)
    const info = runs && runs.get(agent.id)
    if (info === undefined) {
      // mid-run: the task's first line, until the run file names it
      const named = agent.isListed ? undefined : this.provisional.get(agent.id)

      return named === undefined
        ? agent
        : { ...agent, label: named.label || agent.label, type: named.isWorkflow ? 'workflow' : agent.type }
    }

    return {
      ...agent,
      label: agent.isListed ? agent.label : info.label || agent.label,
      type: agent.isListed ? agent.type : 'workflow',
      workflow: { runId: info.runId, name: info.name, phase: info.phase },
    }
  }

  // ── details: what the sidebar or a panel shows of one agent, kept current while it is open ──

  watchDetail(key, sessionId, agentId, mode, post) {
    this.watches.set(key, { sessionId, agentId, mode, post, path: undefined, parsedSize: -1, signature: '' })
    void this.refreshDetail(this.watches.get(key)).catch(() => undefined)
  }

  async refreshDetails() {
    for (const watch of [...this.watches.values()]) {
      await this.refreshDetail(watch).catch(() => undefined)
    }
  }

  /** Sends a detail again, changed or not: a page that just loaded missed what was posted before it listened. */
  async repost(watch) {
    await this.refreshDetail(watch)
    watch.signature = ''
    await this.refreshDetail(watch)
  }

  /** One refresh of a detail at a time: a call while one runs waits for it rather than racing it. */
  refreshDetail(watch) {
    if (watch.inFlight === undefined) {
      watch.inFlight = this.refreshDetailNow(watch).finally(() => {
        watch.inFlight = undefined
      })
    }

    return watch.inFlight
  }

  /** Re-reads the agent's transcript when it grew, and posts the detail when anything it shows changed. */
  async refreshDetailNow(watch) {
    const entry = [...this.files.values()].find(candidate => candidate.snapshot.sessionId === watch.sessionId)
    const snapshot = entry && entry.snapshot
    const row = snapshot && snapshot.agents.find(agent => agent.id === watch.agentId)
    const agent = row && this.withWorkflow(watch.sessionId, row)

    if (watch.path === undefined) {
      const transcript = await this.sessionTranscript(watch.sessionId)
      watch.path = transcript === undefined ? undefined : await findAgentTranscript(transcript, watch.agentId)
    }
    let size = -1
    if (watch.path !== undefined) {
      try {
        size = (await fs.promises.stat(watch.path)).size
      } catch {
        watch.path = undefined
      }
    }

    const signature = [size, agent ? `${agent.status}|${agent.steps}|${agent.endedAt || ''}|${agent.label}` : ''].join('|')
    if (signature === watch.signature) {
      return
    }
    watch.signature = signature
    if (watch.path !== undefined && size !== watch.parsedSize) {
      const read = await readTranscriptText(watch.path, size)
      watch.transcript = { ...parseAgentTranscript(read.text, DETAIL_LIMITS[watch.mode]), truncated: read.truncated }
      watch.parsedSize = size
      watch.meta = await readJson(watch.path.replace(/\.jsonl$/i, '.meta.json'))
    }
    watch.post(this.detailOf(watch, snapshot, agent))
  }

  /** The detail as both webviews draw it: the agent's live row, its session, its run, its parsed transcript. */
  detailOf(watch, snapshot, agent) {
    const runs = this.workflowAgents.get(watch.sessionId)
    const info = runs && runs.get(watch.agentId)
    const status =
      agent !== undefined
        ? agent.status
        : info !== undefined
          ? { done: 'done', error: 'failed', running: 'running' }[info.state] || 'done'
          : 'done'
    const isLive = status === 'running'
    let transcript = watch.transcript
    if (transcript !== undefined && transcript.output === undefined && transcript.finalText !== undefined && !isLive) {
      // its last words, once it has ended, are its answer: shown as the report, not again among the steps
      transcript = { ...transcript, output: { via: 'text', ...transcript.finalText }, events: transcript.events.slice(0, -1) }
    }
    const title = this.titleOf(watch.sessionId)

    return {
      key: `${watch.sessionId}:${watch.agentId}`,
      sessionId: watch.sessionId,
      agentId: watch.agentId,
      status,
      agent:
        agent ||
        (info && { id: watch.agentId, label: info.label, type: 'workflow', status, startedAt: info.startedAt }) || {
          id: watch.agentId,
          label: (watch.meta && watch.meta.description) || `子代理 ${watch.agentId.slice(0, 7)}`,
          type: watch.meta && watch.meta.agentType,
          status,
        },
      session: snapshot && { name: title || projectOf(snapshot.cwd), cwd: snapshot.cwd, model: snapshot.model },
      workflow: info && { name: info.name, phase: info.phase },
      meta: watch.meta,
      transcript,
      missing: transcript === undefined,
    }
  }

  /** One agent in an editor panel: wide, everything open, kept current while the panel lives. */
  openPanel(sessionId, agentId, label) {
    const key = `${sessionId}:${agentId}`
    const open = this.panels.get(key)
    if (open !== undefined) {
      open.reveal()

      return
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const panel = vscode.window.createWebviewPanel('agentBoard.agent', `子代理：${label || agentId.slice(0, 7)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true,
    })
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg')
    panel.webview.html = this.html(panel.webview, ['detail.js', 'panel.js'], '<div id="detail" class="d-panel"></div>', 'is-panel')
    const watchKey = `panel:${key}`
    panel.webview.onDidReceiveMessage(message => {
      if (message === null || typeof message !== 'object') {
        return
      }
      if (message.type === 'ready') {
        const watch = this.watches.get(watchKey)
        if (watch !== undefined) {
          void this.repost(watch).catch(() => undefined)
        }
      } else if (message.type === 'copy') {
        this.copy(message.text)
      }
    })
    panel.onDidDispose(() => {
      this.panels.delete(key)
      this.watches.delete(watchKey)
    })
    this.panels.set(key, panel)
    this.watchDetail(watchKey, sessionId, agentId, 'panel', data => {
      void panel.webview.postMessage({ type: 'detail', data })
      // the tab's title follows a label that arrives late (a workflow's, from its run file)
      if (data.agent && data.agent.label) {
        panel.title = `子代理：${data.agent.label}`
      }
    })
  }

  copy(text) {
    if (typeof text !== 'string') {
      return
    }
    void Promise.resolve(vscode.env.clipboard.writeText(text)).then(() =>
      vscode.window.setStatusBarMessage('$(check) 已複製子代理的回報', 2_500),
    )
  }

  /** A webview page: the board's stylesheet, these scripts (nonce'd), this body. */
  html(webview, scripts, body, bodyClass) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const nonce = crypto.randomBytes(16).toString('base64')
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'board.css'))
    const tags = scripts
      .map(name => `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, name))}"></script>`)
      .join('\n')

    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Agent Board</title>
</head>
<body class="${bodyClass || ''}">
${body}
${tags}
</body>
</html>`
  }

  async readShared() {
    const file = path.join(path.dirname(dataDirectory()), 'plan.json')
    try {
      const stat = await fs.promises.stat(file)
      if (stat.mtimeMs !== this.sharedMtime) {
        this.shared = JSON.parse(await fs.promises.readFile(file, 'utf8'))
        this.sharedMtime = stat.mtimeMs
      }
    } catch {
      // missing until a session's first read, or caught mid-write
    }
  }

  /**
   * Each live session's title, as Claude Code wrote it into the transcript: a first read takes the
   * tail (the whole file once, should the tail hold none), later ones only what was appended.
   * At most two reads a poll.
   */
  async refreshTitles(sessions) {
    const now = Date.now()
    let reads = 0
    for (const session of sessions) {
      if (session.isClosed || reads >= 2) {
        continue
      }
      let entry = this.titles.get(session.sessionId)
      if (entry === undefined) {
        entry = { path: undefined, size: 0, custom: undefined, ai: undefined, isScanned: false, checkedAt: 0, soughtAt: 0 }
        this.titles.set(session.sessionId, entry)
      }
      if (entry.path === undefined) {
        if (now - entry.soughtAt < TITLE_SEEK_MS) {
          continue
        }
        entry.soughtAt = now
        entry.path = await findTranscript(session.sessionId)
        if (entry.path === undefined) {
          continue
        }
      }
      const hasTitle = entry.custom !== undefined || entry.ai !== undefined
      if (now - entry.checkedAt < (hasTitle ? TITLE_RECHECK_MS : TITLE_SEEK_MS)) {
        continue
      }
      entry.checkedAt = now
      try {
        const stat = await fs.promises.stat(entry.path)
        if (stat.size === entry.size) {
          continue
        }
        reads += 1
        const isAppended = entry.size > 0 && stat.size > entry.size
        const from = isAppended
          ? Math.max(0, entry.size - TITLE_OVERLAP_BYTES)
          : Math.max(0, stat.size - TITLE_TAIL_BYTES)
        let found = titlesIn(await readRange(entry.path, from, stat.size))
        if (!isAppended && !hasTitle && found.custom === undefined && found.ai === undefined && from > 0 && !entry.isScanned) {
          entry.isScanned = true
          found = titlesIn(await readRange(entry.path, 0, stat.size))
        }
        entry.size = stat.size
        entry.custom = found.custom || entry.custom
        entry.ai = found.ai || entry.ai
      } catch {
        entry.path = undefined
      }
    }
  }

  titleOf(sessionId) {
    const entry = this.titles.get(sessionId)

    return entry === undefined ? undefined : entry.custom || entry.ai
  }

  /**
   * The focused Claude tab, matched to a session by its label: the context meter follows it. A new
   * conversation's tab has no title to match yet; it is taken for the one live session without one.
   */
  updateFocus(sessions) {
    const group = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
    const tab = group && group.activeTab
    if (!tab || !isClaudeTab(tab)) {
      // a file or another panel: the last Claude tab stays the current one
      return false
    }
    const live = (sessions || this.sessions()).filter(session => isLive(session, Date.now()))
    const named = live.filter(session => {
      const title = this.titleOf(session.sessionId)

      return title !== undefined && tabLabelOf(title) === tab.label
    })
    const untitled = live.filter(session => this.titleOf(session.sessionId) === undefined)
    const match =
      named.find(session => session.sessionId === this.focusedSessionId) ||
      named[0] ||
      (named.length === 0 && untitled.length === 1 ? untitled[0] : undefined)
    if (match === undefined || match.sessionId === this.focusedSessionId) {
      return false
    }
    this.focusedSessionId = match.sessionId

    return true
  }

  watchFocus() {
    const onChange = () => {
      if (this.updateFocus()) {
        this.publish()
      }
    }
    if (vscode.window.tabGroups) {
      this.context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(onChange),
        vscode.window.tabGroups.onDidChangeTabGroups(onChange),
      )
    }
  }

  /**
   * The session the context meter shows: the focused Claude tab's while it is live; else, with no
   * tab matched, the one shown before, and only when that one is gone the live session that acted
   * last — so the meter never hops between sessions as they take turns working.
   */
  currentSessionId(sessions) {
    const now = Date.now()
    const live = sessions.filter(session => isLive(session, now))
    const isLiveId = id => id !== undefined && live.some(session => session.sessionId === id)
    if (isLiveId(this.focusedSessionId)) {
      return { sessionId: this.focusedSessionId, isFocused: true }
    }
    if (!isLiveId(this.pickedSessionId)) {
      const actedAt = session => (session.activity && session.activity.since) || session.updatedAt
      const latest = [...live].sort((a, b) => actedAt(b) - actedAt(a))[0]
      this.pickedSessionId = latest ? latest.sessionId : undefined
    }

    return { sessionId: this.pickedSessionId, isFocused: false }
  }

  sessions() {
    const now = Date.now()

    return [...this.files.values()]
      .map(entry => entry.snapshot)
      .filter(snapshot =>
        snapshot.isClosed
          ? snapshot.agents.length > 0 && now - snapshot.updatedAt < KEEP_CLOSED_MS
          : now - snapshot.updatedAt < KEEP_OPEN_MS,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  publish() {
    // each snapshot with its title, when the transcript has one, and its workflow agents named
    const sessions = this.sessions().map(session => {
      const title = this.titleOf(session.sessionId)
      const agents = session.agents.map(agent => this.withWorkflow(session.sessionId, agent))

      return { ...session, ...(title === undefined ? {} : { title }), agents }
    })
    this.usage = mergeUsage(sessions, this.shared)
    const current = this.currentSessionId(sessions)
    const payload = JSON.stringify({
      sessions,
      usage: this.usage,
      currentSessionId: current.sessionId,
      isCurrentFocused: current.isFocused,
    })
    const running = sessions.reduce(
      (count, session) =>
        count + (session.isClosed ? 0 : session.agents.filter(agent => agent.status === 'running').length),
      0,
    )

    this.updateStatusBar(sessions, running)
    this.updateUsageItem()
    this.updateContextItem(sessions, current)
    this.notify(sessions)

    if (
      running >= AUTO_REVEAL_AT &&
      this.runningBefore < AUTO_REVEAL_AT &&
      this.view !== undefined &&
      !this.view.visible &&
      vscode.workspace.getConfiguration('agentBoard').get('autoReveal', true)
    ) {
      this.view.show(true)
    }
    this.runningBefore = running

    if (payload !== this.lastPayload) {
      this.lastPayload = payload
      this.send()
    }
  }

  toast(kind, text) {
    const action = '打開面板'
    const shown =
      kind === 'error'
        ? vscode.window.showErrorMessage(text, action)
        : kind === 'warning'
          ? vscode.window.showWarningMessage(text, action)
          : vscode.window.showInformationMessage(text, action)
    void Promise.resolve(shown).then(choice => {
      if (choice === action) {
        void vscode.commands.executeCommand('agentBoard.open')
      }
    })
  }

  /**
   * Notifications on state changes, as Learning Hacker's dispatch-board toasts: the first poll is a
   * baseline only, so a reload never replays what already happened.
   */
  notify(sessions) {
    const config = vscode.workspace.getConfiguration('agentBoard')
    const now = Date.now()
    const current = new Map()
    for (const session of sessions) {
      const project = nameOf(session, 40)
      if (session.activity) {
        current.set(`s:${session.sessionId}`, { ...session.activity, project, live: isLive(session, now) })
      }
      for (const agent of session.agents) {
        current.set(`a:${session.sessionId}:${agent.id}`, { ...agent, project })
      }
    }

    const isFirst = this.baseline === undefined
    const before = this.baseline || new Map()
    this.baseline = current

    // a session waiting on the person: once per wait, after it has lasted a little
    const waits = new Set()
    for (const [key, item] of current) {
      if (!key.startsWith('s:') || item.state !== 'waiting' || !item.live) {
        continue
      }
      const id = `${key}@${item.since}`
      waits.add(id)
      if (this.waitNotified.has(id) || (!isFirst && now - item.since < WAIT_NOTIFY_MS)) {
        continue
      }
      this.waitNotified.add(id)
      if (!isFirst && config.get('notify.waiting', true)) {
        this.toast('warning', `「${item.project}」的 Claude 在等你：${item.reason || '等你回覆'}`)
      }
    }
    for (const id of [...this.waitNotified]) {
      if (!waits.has(id)) {
        this.waitNotified.delete(id)
      }
    }

    this.notifyUsage(isFirst)
    if (isFirst) {
      return
    }

    const finished = []
    const failed = []
    for (const [key, item] of current) {
      const previous = before.get(key)
      if (previous === undefined) {
        continue
      }
      if (key.startsWith('a:') && previous.status === 'running') {
        if (item.status === 'done') {
          finished.push(item)
        }
        if (item.status === 'failed') {
          failed.push(item)
        }
      }
      if (
        key.startsWith('s:') &&
        previous.state === 'working' &&
        item.state === 'idle' &&
        item.since - previous.since >= LONG_TURN_MS &&
        config.get('notify.turnDone', true)
      ) {
        this.toast('info', `「${item.project}」這一輪做完了（工作了 ${formatElapsed(item.since - previous.since)}）`)
      }
    }

    if (config.get('notify.subagents', true)) {
      if (finished.length >= BATCH_AT) {
        this.toast('info', `✓ ${finished.length} 個子代理完成`)
      } else {
        for (const item of finished) {
          this.toast('info', `✓ 子代理完成：${item.label}（${formatElapsed((item.endedAt || now) - item.startedAt)}）`)
        }
      }
      for (const item of failed) {
        this.toast('error', `✕ 子代理失敗：${item.label}`)
      }
    }
  }

  /** A usage window crossing 80% or 90%; a reset (a new resetsAt) starts it over, silently. */
  notifyUsage(isFirst) {
    for (const window of this.usage.list) {
      if (!WINDOW_ORDER.includes(window.key)) {
        continue
      }
      const level = USAGE_THRESHOLDS.filter(threshold => window.percent >= threshold).pop() || 0
      const previous = this.usageLevels.get(window.key)
      // a reading without its reset time belongs to the window already known
      const resetsAt = window.resetsAt || (previous && previous.resetsAt)
      const isNewWindow = previous === undefined || !isSameReset(previous.resetsAt, resetsAt)
      // the highest level the window reached: a figure swaying between two sources (79.6, then 80) toasts once
      this.usageLevels.set(window.key, { level: isNewWindow ? level : Math.max(level, previous.level), resetsAt })
      if (isFirst || isNewWindow || level <= previous.level) {
        continue
      }
      if (vscode.workspace.getConfiguration('agentBoard').get('notify.usage', true)) {
        const reset = window.resetsAt ? `，${resetText(window.resetsAt, Date.now())}` : ''
        this.toast(level >= 90 ? 'error' : 'warning', `${window.label}已用 ${Math.round(window.percent)}%${reset}`)
      }
    }
  }

  updateStatusBar(sessions, running) {
    const now = Date.now()
    const waiting = sessions.filter(
      session => isLive(session, now) && session.activity && session.activity.state === 'waiting',
    )
    if (waiting.length > 0) {
      this.status.text =
        waiting.length === 1 ? `$(bell) 「${nameOf(waiting[0], 16)}」在等你` : `$(bell) ${waiting.length} 個對話在等你`
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      this.status.tooltip = [
        ...waiting.map(
          session =>
            `⏸ ${nameOf(session)}：${session.activity.reason || '等你回覆'}（已等 ${formatElapsed(now - session.activity.since)}）`,
        ),
        ...(running > 0 ? ['', `${running} 個子代理執行中`] : []),
        '',
        '按一下打開 Agent Board',
      ].join('\n')
      this.status.show()

      return
    }
    this.status.backgroundColor = undefined

    if (running === 0) {
      this.status.hide()

      return
    }
    const names = sessions
      .flatMap(session => (session.isClosed ? [] : session.agents))
      .filter(agent => agent.status === 'running')
      .map(agent => `● ${agent.label}`)
    this.status.text = `$(sync~spin) ${running} 個子代理執行中`
    this.status.tooltip = `${names.join('\n')}\n\n按一下打開 Agent Board`
    this.status.show()
  }

  /**
   * The subscription's 5-hour and weekly use, always in view, as `mergeUsage` settled them; the
   * tooltip names the source and age of each figure.
   */
  updateUsageItem() {
    if (!vscode.workspace.getConfiguration('agentBoard').get('usageInStatusBar', true)) {
      this.usageItem.hide()

      return
    }

    const list = this.usage.list
    const five = list.find(window => window.key === 'five_hour')
    const week = list.find(window => window.key === 'seven_day')
    if (five === undefined && week === undefined) {
      this.usageItem.hide()

      return
    }

    const parts = []
    if (five !== undefined) {
      parts.push(`5h ${Math.round(five.percent)}%`)
    }
    if (week !== undefined) {
      parts.push(`週 ${Math.round(week.percent)}%`)
    }
    const peak = Math.max(...[five, week].filter(window => window !== undefined).map(window => window.percent))

    this.usageItem.text = `$(pulse) ${parts.join(' · ')}`
    this.usageItem.backgroundColor =
      peak >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : peak >= 70
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined
    const now = Date.now()
    const lines = [
      '訂閱用量',
      ...list.map(
        window =>
          `${window.label}：${Math.round(window.percent)}%` +
          `${window.resetsAt ? `，${resetText(window.resetsAt, now)}` : ''}` +
          `（${SOURCE_LABEL[window.source] || window.source}・${agoText(now - window.at)}）`,
      ),
    ]
    const problem = planProblem(this.usage, now)
    if (problem !== undefined) {
      lines.push('', `⚠ ${problem}`)
    }
    lines.push(
      '',
      '每一項取兩個來源裡較高的讀數（同一段期間內用量只會增加）：',
      '「查詢」＝所有分頁共用，每 30 秒向 claude.ai 問一次，數字最準',
      '「回應」＝Claude 每次回覆時附帶的額度，不含那一次回覆本身，會略低',
      '',
      '按一下打開 Agent Board',
    )
    this.usageItem.tooltip = lines.join('\n')
    this.usageItem.show()
  }

  /**
   * The current conversation's context fill: the focused Claude tab's session, so it is always
   * plain whose it is. The tooltip lists every live conversation's.
   */
  updateContextItem(sessions, current) {
    const session = sessions.find(candidate => candidate.sessionId === current.sessionId)
    const context = contextOf(session)
    if (context === undefined || !vscode.workspace.getConfiguration('agentBoard').get('contextInStatusBar', true)) {
      this.contextItem.hide()

      return
    }

    const describe = (candidate, measured) =>
      `${nameOf(candidate, 30)}：${Math.round(measured.percent)}%（${formatTokens(measured.tokens)} / ${formatTokens(measured.window)}）`
    const now = Date.now()
    const others = sessions
      .filter(candidate => candidate.sessionId !== session.sessionId && isLive(candidate, now))
      .map(candidate => [candidate, contextOf(candidate)])
      .filter(([, measured]) => measured !== undefined)

    this.contextItem.text = `$(pie-chart) 上下文 ${Math.round(context.percent)}%`
    this.contextItem.backgroundColor =
      context.percent >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : context.percent >= 70
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined
    this.contextItem.tooltip = [
      current.isFocused ? '目前對話的上下文（跟著你點開的 Claude 分頁）' : '最近活動的對話的上下文（還沒對上 Claude 分頁，點一下分頁就會跟著它）',
      describe(session, context),
      context.isEstimate
        ? '和 /context 同一種算法：上一次回應的用量，加上之後新加入的內容（估算）'
        : '上一次回應時的用量',
      ...(others.length === 0 ? [] : ['', '其他對話：', ...others.map(([candidate, measured]) => `・${describe(candidate, measured)}`)]),
      '',
      '按一下打開 Agent Board',
    ].join('\n')
    this.contextItem.show()
  }

  send() {
    if (this.view === undefined || this.lastPayload === '') {
      return
    }
    void this.view.webview.postMessage({ type: 'data', ...JSON.parse(this.lastPayload) })
  }

  resolveWebviewView(view) {
    this.view = view
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const webview = view.webview
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    webview.html = this.html(webview, ['detail.js', 'board.js'], '<div id="app"></div>')

    webview.onDidReceiveMessage(message => {
      if (message === null || typeof message !== 'object') {
        return
      }
      if (message.type === 'ready') {
        this.send()
        const watch = this.watches.get('view')
        if (watch !== undefined) {
          void this.repost(watch).catch(() => undefined)
        }
      } else if (message.type === 'detail-open' && typeof message.sessionId === 'string' && typeof message.agentId === 'string') {
        this.watchDetail('view', message.sessionId, message.agentId, 'sidebar', data => {
          if (this.view !== undefined) {
            void this.view.webview.postMessage({ type: 'detail', data })
          }
        })
      } else if (message.type === 'detail-close') {
        this.watches.delete('view')
      } else if (message.type === 'open-panel' && typeof message.sessionId === 'string' && typeof message.agentId === 'string') {
        this.openPanel(message.sessionId, message.agentId, message.label)
      } else if (message.type === 'copy') {
        this.copy(message.text)
      }
    })
    view.onDidDispose(() => {
      this.view = undefined
      this.watches.delete('view')
    })
  }
}

function activate(context) {
  const board = new AgentBoard(context)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentBoard.view', board, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('agentBoard.open', () =>
      vscode.commands.executeCommand('agentBoard.view.focus'),
    ),
  )

  board.watchFocus()
  void board.prune()
  void board.poll()
  const timer = setInterval(() => {
    void board.poll()
  }, POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
}

function deactivate() {}

// AgentBoard and the pure helpers are exported for the tests, which drive them with a stand-in vscode module.
module.exports = {
  activate,
  deactivate,
  AgentBoard,
  mergeUsage,
  titlesIn,
  tabLabelOf,
  parseAgentTranscript,
  parseWorkflowRun,
  findAgentTranscript,
  DETAIL_LIMITS,
}
