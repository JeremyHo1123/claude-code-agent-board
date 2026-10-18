// Agent Board webview: draws what the extension posts ({ type: 'data', sessions, usage, currentSessionId,
// isCurrentFocused }). Running cards and meters are keyed and updated in place, so their animations never restart.
// A card or row opens that agent's detail (media/detail.js draws it), which the extension keeps current
// with { type: 'detail', data } while it is open.
;(function () {
  'use strict'

  const vscode = acquireVsCodeApi()
  const saved = vscode.getState() || {}
  const ui = {
    endedOpen: saved.endedOpen !== false,
    /** The list of the current conversation's prompts: closed until asked for. */
    promptsOpen: saved.promptsOpen === true,
    /** The agent whose detail is open: { sessionId, agentId, key }; undefined on the board. */
    detail: saved.detail && typeof saved.detail.key === 'string' ? saved.detail : undefined,
  }

  /** A running agent with no tool call for this long reads as quiet. */
  const QUIET_MS = 120_000
  /** A session whose snapshot is older than this, with agents still running, reads as lost. */
  const LOST_MS = 60_000
  const SHOWN_ENDED = 20
  /** A session whose snapshot is younger than this is alive: the mod writes a heartbeat every minute. */
  const LIVE_MS = 180_000
  /** A failure this recent still asks for attention; older ones join the ended list. */
  const RECENT_FAIL_MS = 30 * 60_000

  const STATE_LABEL = {
    running: 'running',
    quiet: 'quiet',
    lost: 'may be cut off',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
  }
  const ROW_GLYPH = { done: '✓', failed: '✕', stopped: '■' }
  /** A window read longer ago than this, while the shared read fails, earns the problem note. */
  const STALE_MS = 90_000
  const SOURCE_TEXT = {
    plan: 'claude.ai usage read (shared by every tab, every 30 seconds; the most exact)',
    response: 'the figure Claude sends with a reply (every reply has one, but it leaves out that reply itself, so it runs a little low)',
  }

  let sessions = []
  /** The subscription usage as the extension settled it: one entry of `accounts` per account on the board. */
  let usageData = { list: [], accounts: [] }
  /** The prompts typed in the current conversation: `{ sessionId, list: [{ at, head }] }`, or undefined. */
  let promptsData
  /** The session the context meter shows: the focused Claude tab's, else the one it settled on. */
  let currentId
  let isCurrentFocused = false
  let hasData = false

  // ── helpers ──────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) {
      node.className = className
    }
    if (text !== undefined) {
      node.textContent = text
    }

    return node
  }

  function setText(node, text) {
    if (node.textContent !== text) {
      node.textContent = text
    }
  }

  const pad = value => String(value).padStart(2, '0')

  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(seconds / 60)

    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
      : `${minutes}:${pad(seconds % 60)}`
  }

  function formatTokens(count) {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    }
    if (count >= 1_000) {
      return `${Math.round(count / 1_000)}k`
    }

    return String(count)
  }

  const formatInt = count => count.toLocaleString('en-US')

  const stepsText = count => (count === 1 ? '1 step' : `${count} steps`)

  function clockOf(ms) {
    const date = new Date(ms)

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  /** When a window resets, worded as claude.ai's usage page words it ("Resets Tue 4:00 AM", on a 24-hour clock): the weekday and the time. */
  function resetText(iso) {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) {
      return ''
    }
    // to the minute: one source says 19:59:59.8, the other 20:00:00
    const date = new Date(Math.round(at / 60_000) * 60_000)

    return `Resets ${WEEKDAY[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function agoText(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 5) {
      return 'updated just now'
    }
    if (seconds < 60) {
      return `updated ${seconds}s ago`
    }
    if (seconds < 3600) {
      return `updated ${Math.floor(seconds / 60)} min ago`
    }

    return `updated ${Math.floor(seconds / 3600)}h ago`
  }

  function projectOf(cwd) {
    const parts = String(cwd || '')
      .split(/[\\/]+/)
      .filter(Boolean)

    return parts[parts.length - 1] || 'conversation'
  }

  /** A session's name: the title Claude Code gave its tab, else its project folder. */
  const nameOf = session => session.title || projectOf(session.cwd)

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

  const levelOf = percent => (percent >= 90 ? 'is-crit' : percent >= 70 ? 'is-warn' : '')

  function modelOf(id) {
    const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(String(id || ''))
    if (match === null) {
      return String(id || '')
    }
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1)

    return match[3] === undefined ? `${name} ${match[2]}` : `${name} ${match[2]}.${match[3]}`
  }

  /** A card's short name for an agent type; the detail keeps the full one. */
  function typeLabel(type) {
    return { 'general-purpose': 'general', 'other (workflow…)': 'workflow' }[type] || type
  }

  /** A workflow agent's tag: its run's name and the phase it works in. */
  function workflowTag(workflow) {
    return workflow.phase ? `${workflow.name} · ${workflow.phase}` : workflow.name
  }

  function splitAction(text) {
    const value = String(text || '')
    const space = value.indexOf(' ')

    return space < 0 ? [value || '—', ''] : [value.slice(0, space), value.slice(space + 1)]
  }

  function stateOf(agent, session, now) {
    if (agent.status !== 'running') {
      return agent.status
    }
    if (session.isClosed || now - session.updatedAt > LOST_MS) {
      return 'lost'
    }

    return now - agent.lastAt > QUIET_MS ? 'quiet' : 'running'
  }

  function save() {
    vscode.setState(ui)
  }

  // ── the data, flattened ──────────────────────────────────────────

  function entries() {
    const withAgents = sessions.filter(session => session.agents.length > 0)
    const isMulti = withAgents.length > 1
    const all = withAgents.flatMap(session =>
      session.agents.map(agent => ({
        key: `${session.sessionId}:${agent.id}`,
        agent,
        session,
        tag: isMulti ? nameOf(session) : '',
      })),
    )

    return {
      running: all.filter(entry => entry.agent.status === 'running'),
      ended: all
        .filter(entry => entry.agent.status !== 'running')
        .sort((a, b) => (b.agent.endedAt || b.agent.lastAt) - (a.agent.endedAt || a.agent.lastAt)),
    }
  }

  const STATE_RANK = { running: 0, quiet: 1, lost: 2 }

  /** By what each needs from the person: troubled runs and recent failures first, then healthy runs, then the rest. */
  function partition(now) {
    const { running, ended } = entries()
    const withState = running
      .map(entry => ({ ...entry, state: stateOf(entry.agent, entry.session, now) }))
      .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.agent.startedAt - b.agent.startedAt)
    const isRecentFailure = entry =>
      entry.agent.status === 'failed' && now - (entry.agent.endedAt || entry.agent.lastAt) < RECENT_FAIL_MS

    return {
      healthy: withState.filter(entry => entry.state === 'running'),
      troubled: withState.filter(entry => entry.state !== 'running'),
      failures: ended.filter(isRecentFailure),
      ended: ended.filter(entry => !isRecentFailure(entry)),
    }
  }

  const isLive = (session, now) => !session.isClosed && now - session.updatedAt < LIVE_MS
  const activityOf = session => session.activity || { state: 'idle', since: session.updatedAt }
  const ACTIVITY_RANK = { waiting: 0, working: 1, idle: 2 }

  /** Live sessions: the current one first, then by what they need (waiting, working, idle), latest first. */
  function liveSessions(now) {
    return sessions
      .filter(session => isLive(session, now))
      .sort(
        (a, b) =>
          (b.sessionId === currentId) - (a.sessionId === currentId) ||
          ACTIVITY_RANK[activityOf(a).state] - ACTIVITY_RANK[activityOf(b).state] ||
          activityOf(b).since - activityOf(a).since,
      )
  }

  // ── skeleton ─────────────────────────────────────────────────────

  const app = document.getElementById('app')

  const top = el('div', 'top')
  const chips = el('div', 'chips')
  top.append(chips)
  const fresh = el('div', 'foot')

  const usage = el('div', 'usage')

  // needs you: sessions waiting on a reply, troubled runs, recent failures
  const attentionSection = el('section', 'section')
  const attentionHead = el('div', 'section-head is-attn')
  const attentionCount = el('span', 'count')
  attentionHead.append(el('span', '', 'Needs you'), attentionCount)
  const waitList = el('div', 'list is-attn')
  const attentionCards = el('div', 'cards')
  const failList = el('div', 'list')
  attentionSection.append(attentionHead, waitList, attentionCards, failList)

  // the other live sessions, when more than one Claude tab is open
  const sessionsSection = el('section', 'section')
  const sessionsHead = el('div', 'section-head')
  const sessionsCount = el('span', 'count')
  sessionsHead.append(el('span', '', 'Conversations'), sessionsCount)
  const sessionList = el('div', 'list')
  sessionsSection.append(sessionsHead, sessionList)

  const runningSection = el('section', 'section')
  const runningHead = el('div', 'section-head')
  const runningCount = el('span', 'count')
  runningHead.append(el('span', '', 'Running'), runningCount)
  const cards = el('div', 'cards')
  runningSection.append(runningHead, cards)

  const endedSection = el('section', 'section')
  const toggle = el('button', 'toggle')
  toggle.type = 'button'
  const endedCount = el('span', 'count')
  toggle.append(el('span', 'chev', '▼'), el('span', '', 'Ended'), endedCount)
  const endedList = el('div', 'ended')
  endedSection.append(toggle, endedList)

  // the current conversation's prompts, to jump to: closed until asked for
  const promptsSection = el('section', 'section')
  const promptsToggle = el('button', 'toggle')
  promptsToggle.type = 'button'
  const promptsCount = el('span', 'count')
  promptsToggle.append(el('span', 'chev', '▼'), el('span', '', 'My prompts'), promptsCount)
  const promptsList = el('div', 'list is-prompts')
  promptsSection.append(promptsToggle, promptsList)

  const empty = el('div', 'empty')

  // one agent's task, in place of the board while it is open
  const detailRoot = el('div', 'detail')
  detailRoot.hidden = true

  const boardParts = [top, usage, promptsSection, attentionSection, sessionsSection, runningSection, endedSection, empty, fresh]
  app.append(...boardParts, detailRoot)

  toggle.addEventListener('click', () => {
    ui.endedOpen = !ui.endedOpen
    save()
    renderEnded()
  })

  promptsToggle.addEventListener('click', () => {
    ui.promptsOpen = !ui.promptsOpen
    save()
    renderPrompts()
  })

  // one listener for every row: the rows are drawn again as the conversation grows
  const jumpFrom = target => {
    const row = target instanceof Element ? target.closest('.row[data-index]') : null
    if (row !== null && promptsData !== undefined) {
      vscode.postMessage({ type: 'prompt-jump', sessionId: promptsData.sessionId, index: Number(row.dataset.index) })
    }
  }
  promptsList.addEventListener('click', event => jumpFrom(event.target))
  promptsList.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      jumpFrom(event.target)
    }
  })

  // ── an agent's detail ────────────────────────────────────────────

  /** What the extension last sent for the open detail. */
  let detailData
  const detailState = window.AgentDetail.newState(() => renderDetail())

  function openDetail(session, agent) {
    const key = `${session.sessionId}:${agent.id}`
    if (ui.detail === undefined || ui.detail.key !== key) {
      detailState.closed.clear()
      detailState.expanded.clear()
      detailState.unfolded.clear()
      detailData = undefined
    }
    ui.detail = { sessionId: session.sessionId, agentId: agent.id, key }
    save()
    vscode.postMessage({ type: 'detail-open', sessionId: session.sessionId, agentId: agent.id })
    renderAll()
    window.scrollTo(0, 0)
  }

  function closeDetail() {
    ui.detail = undefined
    detailData = undefined
    save()
    vscode.postMessage({ type: 'detail-close' })
    renderAll()
  }

  /** The open agent's live row and its session, from the board's own data. */
  function liveOf(key) {
    for (const session of sessions) {
      for (const agent of session.agents) {
        if (`${session.sessionId}:${agent.id}` === key) {
          return { session, agent }
        }
      }
    }

    return undefined
  }

  function renderDetail() {
    const isOpen = ui.detail !== undefined
    detailRoot.hidden = !isOpen
    for (const part of boardParts) {
      part.classList.toggle('is-behind', isOpen)
    }
    if (!isOpen) {
      detailRoot.replaceChildren()
      return
    }

    const now = Date.now()
    const live = liveOf(ui.detail.key)
    // the board's row is fresher than the detail's copy of it: its state, steps and label lead
    const base =
      detailData !== undefined && detailData.key === ui.detail.key
        ? detailData
        : { key: ui.detail.key, missing: true, error: "Reading this subagent's transcript…" }
    const data = live
      ? {
          ...base,
          agent: { ...(base.agent || {}), ...live.agent },
          status: stateOf(live.agent, live.session, now),
          session: base.session || { name: nameOf(live.session) },
        }
      : base
    window.AgentDetail.render(detailRoot, data, {
      wide: false,
      now,
      state: detailState,
      onBack: closeDetail,
      onOpenPanel: () =>
        vscode.postMessage({
          type: 'open-panel',
          sessionId: ui.detail.sessionId,
          agentId: ui.detail.agentId,
          label: data.agent && data.agent.label,
        }),
      onCopy: text => vscode.postMessage({ type: 'copy', text }),
    })
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui.detail !== undefined) {
      closeDetail()
    }
  })

  // ── top bar ──────────────────────────────────────────────────────

  function chip(kind, glyph, count, label) {
    const node = el('span', `chip c-${kind}`)
    const value = el('b', '', String(count))
    node.append(el('span', 'glyph', glyph), value, document.createTextNode(` ${label}`))

    return node
  }

  function renderTop(now) {
    const agents = sessions.flatMap(session => session.agents)
    const count = status => agents.filter(agent => agent.status === status).length
    const nodes = []
    const waiting = liveSessions(now).filter(session => activityOf(session).state === 'waiting').length
    const running = count('running')
    const done = count('done')
    const failed = count('failed')
    const stopped = count('stopped')

    if (waiting > 0) {
      nodes.push(chip('warn', '⏸', waiting, 'waiting'))
    }
    if (running > 0) {
      nodes.push(chip('run', '●', running, 'running'))
    }
    if (done > 0) {
      nodes.push(chip('good', '✓', done, 'done'))
    }
    if (failed > 0) {
      nodes.push(chip('crit', '✕', failed, 'failed'))
    }
    if (stopped > 0) {
      nodes.push(chip('serious', '■', stopped, 'stopped'))
    }

    const signature = `${waiting}/${running}/${done}/${failed}/${stopped}`
    if (chips.dataset.signature !== signature) {
      chips.dataset.signature = signature
      chips.replaceChildren(...nodes)
    }
    top.hidden = nodes.length === 0

    const latest = sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0)
    setText(fresh, latest === 0 ? '' : agoText(now - latest))
  }

  // ── usage: the subscription's windows, then the main conversation's context ──
  // Keyed like the running cards: a new reading slides its bar instead of redrawing the card.

  /** How long until a window resets: "in 4h 51m". */
  function untilText(iso, now) {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) {
      return ''
    }
    const minutes = Math.ceil((at - now) / 60_000)
    if (minutes <= 0) {
      return 'due now'
    }
    if (minutes < 60) {
      return `in ${minutes} min`
    }
    const hours = Math.floor(minutes / 60)

    return hours < 24 ? `in ${hours}h ${minutes % 60}m` : `in ${Math.floor(hours / 24)}d ${hours % 24}h`
  }

  function shortAgo(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 5) {
      return 'just now'
    }
    if (seconds < 60) {
      return `${seconds}s ago`
    }

    return seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)}h ago`
  }

  function money(minor, currency) {
    const amount = (minor / 100).toFixed(2)

    return currency === null || currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
  }

  function inText(ms) {
    const seconds = Math.max(1, Math.ceil(ms / 1000))

    return seconds < 60 ? `in ${seconds}s` : seconds < 3600 ? `in ${Math.ceil(seconds / 60)} min` : `in ${Math.ceil(seconds / 3600)}h`
  }

  /** Why an account's shared claude.ai read is behind, and when it is tried again; undefined while it works. */
  function planProblem(account, now) {
    const error = account.planError
    if (!error) {
      return undefined
    }
    const what = error.status === 429 ? 'rate-limited' : error.status ? `failed (HTTP ${error.status})` : 'failed'
    const nextAt = account.planNextAt
    const retry = typeof nextAt === 'number' && nextAt > now ? `, retrying ${inText(nextAt - now)}` : ''

    return {
      text: `Usage read ${what}${retry}`,
      detail: [
        `claude.ai usage read ${what} (${clockOf(error.at)})${error.message ? `: ${error.message}` : ''}`,
        'The figures sent with replies are unaffected: while a conversation works, the 5-hour and weekly use still update as it happens.',
      ].join('\n'),
    }
  }

  /** What an account is called where two are shown: its sign-in's email, else that it is not known. */
  function accountName(account) {
    return account.label || (account.id === '' ? 'Unidentified account' : `Account ${account.id.slice(0, 6)}`)
  }

  /** An account's windows as the extension settled them, with where and when each figure was read. */
  function windowRows(account, now) {
    return account.list.map(window => ({
      key: `w:${account.id}:${window.key}`,
      label: window.label,
      percent: window.percent,
      at: window.at,
      // the reset as claude.ai's usage page words it; how long that is from now joins it where there is room
      foot: window.resetsAt ? resetText(window.resetsAt) : '',
      footExtra: window.resetsAt ? ` · ${untilText(window.resetsAt, now)}` : '',
      title: [
        `${window.label}: ${Math.round(window.percent)}% used`,
        ...(window.resetsAt ? [`${resetText(window.resetsAt)} (${untilText(window.resetsAt, now)})`] : []),
        `Source: ${SOURCE_TEXT[window.source] || window.source}`,
        `Read at ${clockOf(window.at)} (${shortAgo(now - window.at)})`,
      ].join('\n'),
    }))
  }

  const CONTEXT_KEY = 'context'
  const meterByKey = new Map()
  /** account id -> its head (title, whose it is, how fresh), note and extra-usage line; kept so nothing redraws */
  const accountParts = new Map()

  function partsFor(id) {
    let parts = accountParts.get(id)
    if (parts === undefined) {
      const head = el('div', 'usage-head')
      const title = el('span', 'usage-title', 'Subscription usage')
      const name = el('span', 'usage-session')
      const fresh = el('span', 'usage-fresh')
      head.append(title, name, fresh)
      parts = { head, title, name, fresh, note: el('div', 'usage-note'), extra: el('div', 'usage-extra') }
      accountParts.set(id, parts)
    }

    return parts
  }
  // the current conversation's context: a sub-head naming the conversation, then its meter
  const contextHead = el('div', 'usage-head is-sub')
  const contextTitle = el('span', 'usage-title')
  const contextName = el('span', 'usage-session')
  contextHead.append(contextTitle, contextName)

  function makeMeter() {
    const node = el('div', 'meter')
    const label = el('span', 'meter-label')
    const foot = el('span', 'meter-foot')
    // the second part shows only in a meter wide enough for both (a container query on the meter)
    const footMain = el('span')
    const footExtra = el('span', 'foot-extra')
    foot.append(footMain, footExtra)
    const value = el('span', 'meter-value')
    const track = el('div', 'meter-track')
    const fill = el('div', 'meter-fill')
    track.append(fill)
    // grid areas place these: label/value over the bar when wide, label/foot/value in one row when narrow
    node.append(label, foot, value, track)

    return { node, label, footMain, footExtra, value, fill }
  }

  function meterFor(key) {
    let meter = meterByKey.get(key)
    if (meter === undefined) {
      meter = makeMeter()
      meterByKey.set(key, meter)
    }

    return meter
  }

  function drawMeter(meter, row) {
    const value = Math.max(0, Math.min(100, row.percent))
    const level = levelOf(value)
    const className = `meter ${level}`.trim()
    if (meter.node.className !== className) {
      meter.node.className = className
    }
    // the warning glyph leads the label, so the value column keeps one width on every row
    setText(meter.label, `${level === '' ? '' : '⚠ '}${row.label}`)
    setText(meter.footMain, row.foot)
    setText(meter.footExtra, row.footExtra || '')
    setText(meter.value, `${Math.round(row.percent)}%`)
    meter.fill.style.setProperty('--pct', `${value}%`)
    meter.node.title = row.title
  }

  /** One account's part of the usage block: its head, meters, note and extra-usage line, in order. */
  function drawAccount(block, index, isMany, now) {
    const { account, rows, problem, isNoteShown } = block
    const parts = partsFor(account.id)
    // with two accounts each head says whose it is, and a rule parts the second from the first
    const headClass = `usage-head${isMany ? ' is-account' : ''}${isMany && account.isCurrent ? ' is-current' : ''}${index > 0 ? ' is-divided' : ''}`
    if (parts.head.className !== headClass) {
      parts.head.className = headClass
    }
    parts.name.hidden = !isMany
    if (isMany) {
      setText(parts.name, accountName(account))
      parts.name.title = [
        accountName(account),
        ...(account.isCurrent ? ['The current conversation uses this account'] : []),
        account.sessions.length > 0 ? `Open conversations: ${account.sessions.join(', ')}` : 'No open conversation uses this account',
      ].join('\n')
    }

    if (rows.length > 0) {
      const freshest = Math.max(...rows.map(row => row.at))
      setText(parts.fresh, `updated ${shortAgo(now - freshest)}`)
      parts.fresh.title = [
        ...account.list.map(
          window => `${window.label}: ${window.source === 'plan' ? 'usage read' : 'reply'}, ${clockOf(window.at)}`,
        ),
        '',
        'Use within a window only grows, so each figure is the higher reading of two sources:',
        `· usage read = ${SOURCE_TEXT.plan}`,
        `· reply = ${SOURCE_TEXT.response}`,
        'After a change of account or a reset, the old readings are dropped at once.',
      ].join('\n')
    } else {
      setText(parts.fresh, 'waiting for a reading')
      parts.fresh.title = ''
    }
    for (const row of rows) {
      drawMeter(meterFor(row.key), row)
    }

    parts.note.hidden = !isNoteShown
    if (isNoteShown) {
      setText(parts.note, problem.text)
      parts.note.title = problem.detail
    }

    const extra = account.extra
    parts.extra.hidden = !extra
    if (extra) {
      const used = extra.usedCredits === null ? '—' : money(extra.usedCredits, extra.currency)
      const limit = extra.monthlyLimit === null ? '' : ` / ${money(extra.monthlyLimit, extra.currency)}`
      const share = extra.percent === null ? '' : ` (${Math.round(extra.percent)}%)`
      setText(parts.extra, `Extra usage ${used}${limit}${share}`)
    }

    return [parts.head, ...rows.map(row => meterByKey.get(row.key).node), parts.note, parts.extra]
  }

  /** Each account's windows (account-wide), then the context of the conversation in view (one session's). */
  function renderUsage(now) {
    const isMany = usageData.accounts.length > 1
    const blocks = usageData.accounts
      .map(account => {
        const rows = windowRows(account, now)
        const problem = planProblem(account, now)
        // the note only when it explains something on screen: a reading gone stale, or none at all
        const isNoteShown = problem !== undefined && (rows.length === 0 || rows.some(row => now - row.at > STALE_MS))

        return { account, rows, problem, isNoteShown }
      })
      // one account with nothing to say shows no head; beside another it still says it is waiting
      .filter(block => block.rows.length > 0 || block.isNoteShown || isMany)
    const current = sessions.find(session => session.sessionId === currentId)
    const context = contextOf(current)
    const hasPlanPart = blocks.length > 0

    usage.hidden = !hasPlanPart && context === undefined
    if (usage.hidden) {
      return
    }

    const keys = new Set([...blocks.flatMap(block => block.rows.map(row => row.key)), ...(context === undefined ? [] : [CONTEXT_KEY])])
    for (const [key, meter] of meterByKey) {
      if (!keys.has(key)) {
        meter.node.remove()
        meterByKey.delete(key)
      }
    }
    for (const id of [...accountParts.keys()]) {
      if (!blocks.some(block => block.account.id === id)) {
        accountParts.delete(id)
      }
    }

    const accountNodes = blocks.flatMap((block, index) => drawAccount(block, index, isMany, now))

    contextHead.hidden = context === undefined
    if (context !== undefined) {
      const className = `usage-head is-sub${hasPlanPart ? ' is-divided' : ''}`
      if (contextHead.className !== className) {
        contextHead.className = className
      }
      setText(contextTitle, isCurrentFocused ? 'Current conversation' : 'Latest conversation')
      contextTitle.title = isCurrentFocused
        ? 'Follows the Claude tab you have open (or opened last)'
        : 'No Claude tab matched yet, so this shows the conversation that moved last; click a Claude tab and it follows that one'
      setText(contextName, nameOf(current))
      contextName.title = [nameOf(current), String(current.cwd || ''), modelOf(current.model)].filter(Boolean).join('\n')
      drawMeter(meterFor(CONTEXT_KEY), {
        label: 'Context',
        percent: context.percent,
        foot: `${formatTokens(context.tokens)} / ${formatTokens(context.window)}`,
        title: [
          `Context: ${formatInt(context.tokens)} / ${formatInt(context.window)} tokens used (${Math.round(context.percent)}%)`,
          context.isEstimate
            ? "Counted as /context counts it: the last reply's usage plus what was added since (an estimate)"
            : "The usage as of the last reply (no /context estimate this time)",
        ].join('\n'),
      })
    }

    const wanted = [
      ...accountNodes,
      contextHead,
      ...(context === undefined ? [] : [meterByKey.get(CONTEXT_KEY).node]),
    ]
    const present = Array.from(usage.children)
    if (wanted.length !== present.length || wanted.some((node, index) => node !== present[index])) {
      usage.replaceChildren(...wanted)
    }
  }

  // ── running cards (keyed, updated in place) ──────────────────────

  const cardByKey = new Map()

  function makeCard(key) {
    const root = el('article', 'card')
    root.tabIndex = 0

    const head = el('div', 'line')
    const label = el('span', 'label body')
    const elapsed = el('span', 'elapsed end')
    head.append(el('span', 'dot lead'), label, elapsed)

    const metaLine = el('div', 'line')
    const meta = el('span', 'meta body')
    metaLine.append(meta)

    const actionLine = el('div', 'line spaced')
    const action = el('div', 'action body')
    const tool = el('span', 'tool')
    const arg = el('span', 'arg')
    action.append(tool, arg)
    actionLine.append(action)

    const noteLine = el('div', 'line')
    const note = el('div', 'note body')
    noteLine.append(note)

    root.append(head, metaLine, actionLine, noteLine, el('div', 'progress'))

    const card = { root, label, elapsed, meta, tool, arg, noteLine, note, metaSignature: '', entry: undefined }
    const open = () => {
      if (card.entry !== undefined) {
        openDetail(card.entry.session, card.entry.agent)
      }
    }
    root.addEventListener('click', open)
    root.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })

    return card
  }

  /** A card's or row's hover text: the facts the detail opens on, and that a click opens it. */
  function detailsText(agent, session) {
    const parts = [`started ${clockOf(agent.startedAt)}`]
    if (agent.endedAt) {
      parts.push(`ended ${clockOf(agent.endedAt)}`)
    }
    parts.push(agent.type, stepsText(agent.steps))
    parts.push(`${nameOf(session)} · ${modelOf(session.model)}`)

    return `${agent.label}\n${parts.join(' · ')}\nClick for the task's details`
  }

  /** Puts each card in its container, re-inserting none that is already in place (its animations keep running). */
  function place(container, list) {
    const wanted = list.map(entry => cardByKey.get(entry.key).root)
    const present = Array.from(container.children)
    const isPrefix = present.length <= wanted.length && present.every((node, index) => node === wanted[index])
    if (isPrefix) {
      container.append(...wanted.slice(present.length))
    } else {
      container.replaceChildren(...wanted)
    }
  }

  /** Running cards: healthy ones under Running, quiet or lost ones under Needs you. */
  function renderRunning(now) {
    const parts = partition(now)
    const list = [...parts.troubled, ...parts.healthy]
    runningSection.hidden = parts.healthy.length === 0
    setText(runningCount, String(parts.healthy.length))

    const keys = new Set(list.map(entry => entry.key))
    for (const [key, card] of cardByKey) {
      if (!keys.has(key)) {
        card.root.remove()
        cardByKey.delete(key)
      }
    }

    for (const { key, agent, session, tag, state } of list) {
      let card = cardByKey.get(key)
      if (card === undefined) {
        card = makeCard(key)
        cardByKey.set(key, card)
      }
      const className = `card is-${state}`
      if (card.root.className !== className) {
        card.root.className = className
      }

      card.entry = { session, agent }
      setText(card.label, agent.label)
      card.root.title = detailsText(agent, session)
      setText(card.elapsed, formatElapsed(now - agent.startedAt))

      // a workflow's agent names its run and phase; a session's name joins when several have agents
      const tags = [...(agent.workflow ? [workflowTag(agent.workflow)] : []), ...(tag ? [tag] : [])]
      const metaText = `${STATE_LABEL[state]} · ${typeLabel(agent.type)} · ${stepsText(agent.steps)}`
      const metaSignature = `${metaText}|${tags.join('|')}`
      if (card.metaSignature !== metaSignature) {
        card.metaSignature = metaSignature
        card.meta.replaceChildren(document.createTextNode(metaText), ...tags.map(text => el('span', 'tag', text)))
      }

      const [toolName, argument] = splitAction(agent.lastAction)
      setText(card.tool, toolName)
      setText(card.arg, argument)
      card.arg.title = agent.lastAction || ''

      const noteText =
        state === 'lost'
          ? 'No word for over a minute; the conversation may be cut off'
          : state === 'quiet'
            ? `No new step for ${Math.floor((now - agent.lastAt) / 60_000)} min; it may be thinking at length`
            : ''
      card.noteLine.hidden = noteText === ''
      setText(card.note, noteText)
    }

    place(attentionCards, parts.troubled)
    place(cards, parts.healthy)
    attentionCards.hidden = parts.troubled.length === 0
  }

  // ── sessions: who waits on you, who works, who is done ───────────

  /** Whether the live sessions sit in more than one project folder: then each row names its folder. */
  function isMultiProject(now) {
    return new Set(sessions.filter(session => isLive(session, now)).map(session => String(session.cwd || ''))).size > 1
  }

  function sessionRow(session, now, showProject) {
    const activity = activityOf(session)
    const isCurrent = session.sessionId === currentId
    const row = el('div', `srow is-${activity.state}${isCurrent ? ' is-current' : ''}`)

    const head = el('div', 'line')
    const label = el('span', 'label body', nameOf(session))
    label.title = [nameOf(session), String(session.cwd || ''), modelOf(session.model)].filter(Boolean).join('\n')
    const glyph = activity.state === 'waiting' ? '⏸' : activity.state === 'working' ? '●' : '○'
    head.append(
      el('span', 'glyph lead', glyph),
      label,
      el('span', 'elapsed end', activity.state === 'idle' ? '' : formatElapsed(now - activity.since)),
    )

    const meta = el('div', 'line')
    // the right-hand figure is how long the state has lasted; the line says what the state is
    const state =
      activity.state === 'waiting'
        ? activity.reason || 'waiting for your reply'
        : activity.state === 'working'
          ? 'working'
          : `idle · turn done ${shortAgo(now - activity.since)}`
    const body = el('span', 'meta body')
    if (isCurrent) {
      const mark = el('span', 'tag is-lead is-current', 'current')
      mark.title = 'The Context meter above shows this conversation'
      body.append(mark)
    }
    body.append(
      document.createTextNode(
        [state, ...(showProject ? [projectOf(session.cwd)] : []), modelOf(session.model)].join(' · '),
      ),
    )
    meta.append(body)

    // each conversation's own context, so a glance compares them without switching tabs
    const context = contextOf(session)
    if (context !== undefined) {
      const figure = el('span', `ctx end ${levelOf(context.percent)}`.trim(), `context ${Math.round(context.percent)}%`)
      figure.title = `Context: ${formatInt(context.tokens)} / ${formatInt(context.window)} tokens used`
      meta.append(figure)
    }
    row.append(head, meta)

    return row
  }

  /** The Needs you section: waiting sessions (redrawn each second: their wait time ticks), troubled cards, recent failures. */
  function renderAttention(now) {
    const parts = partition(now)
    const live = liveSessions(now)
    const waiting = live.filter(session => activityOf(session).state === 'waiting')
    const showProject = isMultiProject(now)

    waitList.replaceChildren(...waiting.map(session => sessionRow(session, now, showProject)))
    waitList.hidden = waiting.length === 0

    const signature = parts.failures.map(entry => `${entry.key}|${entry.agent.label}`).join('|')
    if (failList.dataset.signature !== signature) {
      failList.dataset.signature = signature
      failList.replaceChildren(...parts.failures.map(makeRow))
    }
    failList.hidden = parts.failures.length === 0

    const total = waiting.length + parts.troubled.length + parts.failures.length
    attentionSection.hidden = total === 0
    setText(attentionCount, String(total))

    // the other live sessions, shown once more than one Claude tab is open
    const others = live.filter(session => activityOf(session).state !== 'waiting')
    sessionsSection.hidden = live.length < 2 || others.length === 0
    setText(sessionsCount, String(others.length))
    if (!sessionsSection.hidden) {
      sessionList.replaceChildren(...others.map(session => sessionRow(session, now, showProject)))
    }
  }

  // ── ended rows ───────────────────────────────────────────────────

  const tokenBar = window.AgentDetail.tokenBar

  function makeRow({ agent, session, tag }) {
    const row = el('div', `row is-${agent.status}`)
    row.tabIndex = 0
    row.title = detailsText(agent, session)

    const head = el('div', 'line')
    const label = el('span', 'label body', agent.label)
    for (const text of [...(agent.workflow ? [workflowTag(agent.workflow)] : []), ...(tag ? [tag] : [])]) {
      label.append(el('span', 'tag', text))
    }
    head.append(
      el('span', 'glyph lead', ROW_GLYPH[agent.status] || '•'),
      label,
      el('span', 'elapsed end', formatElapsed((agent.endedAt || agent.lastAt) - agent.startedAt)),
    )
    row.append(head)

    const detail = el('div', 'line spaced')
    const body = el('div', 'body')
    if (agent.status === 'done') {
      body.append(agent.tokens ? tokenBar(agent.tokens) : el('span', 'note', `done · ${stepsText(agent.steps)} · no token record`))
    } else if (agent.status === 'failed') {
      const note = el('span', 'note', `failed · last step: ${agent.lastAction || '—'}`)
      note.title = agent.lastAction || ''
      body.append(note)
    } else {
      body.append(el('span', 'note', `stopped · ${stepsText(agent.steps)}`))
    }
    detail.append(body)
    row.append(detail)

    const open = () => openDetail(session, agent)
    row.addEventListener('click', open)
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })

    return row
  }

  function renderEnded() {
    const list = partition(Date.now()).ended
    endedSection.hidden = list.length === 0
    setText(endedCount, String(list.length))
    toggle.setAttribute('aria-expanded', String(ui.endedOpen))
    endedList.hidden = !ui.endedOpen || list.length === 0

    if (endedList.hidden) {
      endedList.replaceChildren()

      return
    }

    const rows = list.slice(0, SHOWN_ENDED).map(makeRow)
    if (list.length > SHOWN_ENDED) {
      const more = el('div', 'row')
      const hidden = list.length - SHOWN_ENDED
      more.append(el('span', 'note', `${hidden} earlier subagent${hidden === 1 ? '' : 's'} not listed`))
      rows.push(more)
    }
    endedList.replaceChildren(...rows)
  }

  // ── the current conversation's prompts ───────────────────────────

  /** What the list last drew, so a poll that changes nothing leaves the rows (and the scroll) alone. */
  let promptsDrawn = ''

  function renderPrompts() {
    const list = promptsData === undefined ? [] : promptsData.list
    promptsSection.hidden = list.length === 0
    setText(promptsCount, String(list.length))
    promptsToggle.setAttribute('aria-expanded', String(ui.promptsOpen))
    promptsToggle.title = 'Every prompt you typed in the current conversation. Click one to search for it in the Claude tab (Enter for the next match)'
    promptsList.hidden = !ui.promptsOpen || list.length === 0

    const signature = promptsList.hidden ? '' : `${promptsData.sessionId}:${list.length}`
    if (signature === promptsDrawn) {
      return
    }
    promptsDrawn = signature
    promptsList.replaceChildren(
      ...(promptsList.hidden ? [] : list).map((prompt, index) => {
        const row = el('div', 'row is-prompt')
        row.tabIndex = 0
        row.dataset.index = String(index)
        row.title = [prompt.head, '', 'Click to search for this prompt in the Claude tab'].join('\n')
        const line = el('div', 'line')
        line.append(
          el('span', 'glyph lead', String(index + 1)),
          el('span', 'label body', prompt.head),
          el('span', 'elapsed end', prompt.at ? clockOf(prompt.at).slice(0, 5) : ''),
        )
        row.append(line)

        return row
      }),
    )
    // the latest prompt is the likeliest wanted: the list opens at its end
    promptsList.scrollTop = promptsList.scrollHeight
  }

  // ── empty state ──────────────────────────────────────────────────

  const EMPTY_ICON =
    '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="20" cy="10" r="4.5"/><circle cx="9" cy="30" r="4.5"/><circle cx="31" cy="30" r="4.5"/>' +
    '<path d="M17.6 13.8 11.4 26.1M22.4 13.8l6.2 12.3M13.5 30h13"/></svg>'

  function renderEmpty() {
    const hasAgents = sessions.some(session => session.agents.length > 0)
    empty.hidden = !hasData || hasAgents
    if (empty.hidden) {
      return
    }

    const title = sessions.length === 0 ? 'No data yet' : 'No subagents right now'
    const sub =
      sessions.length === 0
        ? 'Check that Claude Code has loaded the agent-board mod: type /agent-board in Claude; an answer means it works.'
        : 'Once a subagent starts, its progress shows here as it happens.'
    if (empty.dataset.title !== title) {
      empty.dataset.title = title
      empty.innerHTML = EMPTY_ICON
      empty.append(el('div', 'empty-title', title), el('div', 'empty-sub', sub))
    }
  }

  // ── wiring ───────────────────────────────────────────────────────

  function renderAll() {
    const now = Date.now()
    renderTop(now)
    renderUsage(now)
    renderPrompts()
    renderAttention(now)
    renderRunning(now)
    renderEnded()
    renderEmpty()
    renderDetail()
  }

  /** The open detail's figures the board's own data moves: its state and steps, redrawn only when they change. */
  let detailRowSignature = ''

  window.addEventListener('message', event => {
    const message = event.data
    if (message && message.type === 'data' && Array.isArray(message.sessions)) {
      sessions = message.sessions
      promptsData = message.prompts && Array.isArray(message.prompts.list) ? message.prompts : undefined
      const posted = message.usage && Array.isArray(message.usage.list) ? message.usage : { list: [] }
      // a message with no `accounts` (the preview's plain one) is one account that names none
      usageData = Array.isArray(posted.accounts) ? posted : { ...posted, accounts: [{ ...posted, id: '', sessions: [] }] }
      currentId = typeof message.currentSessionId === 'string' ? message.currentSessionId : undefined
      isCurrentFocused = message.isCurrentFocused === true
      hasData = true
      const now = Date.now()
      renderTop(now)
      renderUsage(now)
      renderAttention(now)
      renderRunning(now)
      renderEnded()
      renderEmpty()
      if (ui.detail !== undefined) {
        const live = liveOf(ui.detail.key)
        const signature = live ? `${stateOf(live.agent, live.session, now)}|${live.agent.steps}|${live.agent.label}` : ''
        if (signature !== detailRowSignature) {
          detailRowSignature = signature
          renderDetail()
        }
      }
    } else if (message && message.type === 'detail' && message.data && ui.detail !== undefined && message.data.key === ui.detail.key) {
      detailData = message.data
      renderDetail()
    }
  })

  setInterval(() => {
    const now = Date.now()
    if (ui.detail !== undefined) {
      window.AgentDetail.tick(detailRoot, now)
      return
    }
    renderTop(now)
    renderUsage(now)
    renderPrompts()
    renderAttention(now)
    renderRunning(now)
  }, 1000)

  renderAll()
  vscode.postMessage({ type: 'ready' })
  // a reopened view picks up the detail it had open
  if (ui.detail !== undefined) {
    vscode.postMessage({ type: 'detail-open', sessionId: ui.detail.sessionId, agentId: ui.detail.agentId })
  }
})()
