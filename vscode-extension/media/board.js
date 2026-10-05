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
    running: '執行中',
    quiet: '暫無動作',
    lost: '可能已中斷',
    done: '完成',
    failed: '失敗',
    stopped: '已中止',
  }
  const ROW_GLYPH = { done: '✓', failed: '✕', stopped: '■' }
  /** A window read longer ago than this, while the shared read fails, earns the problem note. */
  const STALE_MS = 90_000
  const SOURCE_TEXT = {
    plan: 'claude.ai 用量查詢（所有分頁共用，每 30 秒一次，數字最準）',
    response: 'Claude 回覆時附帶的額度（每次回覆都有，但不含那一次回覆本身，會略低）',
  }

  let sessions = []
  /** The subscription's windows, each from its freshest source, merged by the extension. */
  let usageData = { list: [] }
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

  function clockOf(ms) {
    const date = new Date(ms)

    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const WEEKDAY = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

  /** When a window resets, worded as claude.ai's usage page words it ("Resets Tue 4:00 AM"): the weekday and the time. */
  function resetText(iso) {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) {
      return ''
    }
    // to the minute: one source says 19:59:59.8, the other 20:00:00
    const date = new Date(Math.round(at / 60_000) * 60_000)

    return `${WEEKDAY[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())} 重置`
  }

  function agoText(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 5) {
      return '剛剛更新'
    }
    if (seconds < 60) {
      return `${seconds} 秒前更新`
    }
    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} 分鐘前更新`
    }

    return `${Math.floor(seconds / 3600)} 小時前更新`
  }

  function projectOf(cwd) {
    const parts = String(cwd || '')
      .split(/[\\/]+/)
      .filter(Boolean)

    return parts[parts.length - 1] || '對話'
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
    return { 'general-purpose': '通用', '其他（workflow 等）': 'workflow' }[type] || type
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
  attentionHead.append(el('span', '', '需要你'), attentionCount)
  const waitList = el('div', 'list is-attn')
  const attentionCards = el('div', 'cards')
  const failList = el('div', 'list')
  attentionSection.append(attentionHead, waitList, attentionCards, failList)

  // the other live sessions, when more than one Claude tab is open
  const sessionsSection = el('section', 'section')
  const sessionsHead = el('div', 'section-head')
  const sessionsCount = el('span', 'count')
  sessionsHead.append(el('span', '', '對話'), sessionsCount)
  const sessionList = el('div', 'list')
  sessionsSection.append(sessionsHead, sessionList)

  const runningSection = el('section', 'section')
  const runningHead = el('div', 'section-head')
  const runningCount = el('span', 'count')
  runningHead.append(el('span', '', '執行中'), runningCount)
  const cards = el('div', 'cards')
  runningSection.append(runningHead, cards)

  const endedSection = el('section', 'section')
  const toggle = el('button', 'toggle')
  toggle.type = 'button'
  const endedCount = el('span', 'count')
  toggle.append(el('span', 'chev', '▼'), el('span', '', '已結束'), endedCount)
  const endedList = el('div', 'ended')
  endedSection.append(toggle, endedList)

  const empty = el('div', 'empty')

  // one agent's task, in place of the board while it is open
  const detailRoot = el('div', 'detail')
  detailRoot.hidden = true

  const boardParts = [top, usage, attentionSection, sessionsSection, runningSection, endedSection, empty, fresh]
  app.append(...boardParts, detailRoot)

  toggle.addEventListener('click', () => {
    ui.endedOpen = !ui.endedOpen
    save()
    renderEnded()
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
        : { key: ui.detail.key, missing: true, error: '正在讀取這個子代理的紀錄…' }
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
      nodes.push(chip('warn', '⏸', waiting, '等你'))
    }
    if (running > 0) {
      nodes.push(chip('run', '●', running, '執行中'))
    }
    if (done > 0) {
      nodes.push(chip('good', '✓', done, '完成'))
    }
    if (failed > 0) {
      nodes.push(chip('crit', '✕', failed, '失敗'))
    }
    if (stopped > 0) {
      nodes.push(chip('serious', '■', stopped, '已中止'))
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

  /** How long until a window resets: "4 小時 51 分後". */
  function untilText(iso, now) {
    const at = Date.parse(iso)
    if (Number.isNaN(at)) {
      return ''
    }
    const minutes = Math.ceil((at - now) / 60_000)
    if (minutes <= 0) {
      return '時間已到'
    }
    if (minutes < 60) {
      return `${minutes} 分後`
    }
    const hours = Math.floor(minutes / 60)

    return hours < 24 ? `${hours} 小時 ${minutes % 60} 分後` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小時後`
  }

  function shortAgo(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 5) {
      return '剛剛'
    }
    if (seconds < 60) {
      return `${seconds} 秒前`
    }

    return seconds < 3600 ? `${Math.floor(seconds / 60)} 分鐘前` : `${Math.floor(seconds / 3600)} 小時前`
  }

  function money(minor, currency) {
    const amount = (minor / 100).toFixed(2)

    return currency === null || currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
  }

  function inText(ms) {
    const seconds = Math.max(1, Math.ceil(ms / 1000))

    return seconds < 60 ? `${seconds} 秒後` : seconds < 3600 ? `${Math.ceil(seconds / 60)} 分鐘後` : `${Math.ceil(seconds / 3600)} 小時後`
  }

  /** Why the shared claude.ai read is behind, and when it is tried again; undefined while it works. */
  function planProblem(now) {
    const error = usageData.planError
    if (!error) {
      return undefined
    }
    const what = error.status === 429 ? '被限流' : error.status ? `失敗（HTTP ${error.status}）` : '失敗'
    const nextAt = usageData.planNextAt
    const retry = typeof nextAt === 'number' && nextAt > now ? `，${inText(nextAt - now)}再試` : ''

    return {
      text: `用量查詢${what}${retry}`,
      detail: [
        `claude.ai 用量查詢${what}（${clockOf(error.at)}）${error.message ? `：${error.message}` : ''}`,
        'Claude 回覆時附帶的額度不受影響：有對話在工作時，5 小時與每週用量照樣即時更新。',
      ].join('\n'),
    }
  }

  /** The subscription's windows as the extension settled them, with where and when each figure was read. */
  function windowRows(now) {
    return usageData.list.map(window => ({
      key: `w:${window.key}`,
      label: window.label,
      percent: window.percent,
      at: window.at,
      // the reset as claude.ai's usage page words it; how long that is from now joins it where there is room
      foot: window.resetsAt ? resetText(window.resetsAt) : '',
      footExtra: window.resetsAt ? `・${untilText(window.resetsAt, now)}` : '',
      title: [
        `${window.label}：已用 ${Math.round(window.percent)}%`,
        ...(window.resetsAt ? [`${resetText(window.resetsAt)}（${untilText(window.resetsAt, now)}）`] : []),
        `來源：${SOURCE_TEXT[window.source] || window.source}`,
        `讀取於 ${clockOf(window.at)}（${shortAgo(now - window.at)}）`,
      ].join('\n'),
    }))
  }

  const CONTEXT_KEY = 'context'
  const meterByKey = new Map()
  const usageHead = el('div', 'usage-head')
  const usageTitle = el('span', 'usage-title', '訂閱用量')
  const usageFresh = el('span', 'usage-fresh')
  usageHead.append(usageTitle, usageFresh)
  const usageNote = el('div', 'usage-note')
  const usageExtra = el('div', 'usage-extra')
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

  /** The subscription's windows (account-wide), then the context of the conversation in view (one session's). */
  function renderUsage(now) {
    const rows = windowRows(now)
    const current = sessions.find(session => session.sessionId === currentId)
    const context = contextOf(current)
    const problem = planProblem(now)
    // the note only when it explains something on screen: a reading gone stale, or none at all
    const isNoteShown = problem !== undefined && (rows.length === 0 || rows.some(row => now - row.at > STALE_MS))
    const hasPlanPart = rows.length > 0 || isNoteShown

    usage.hidden = !hasPlanPart && context === undefined
    if (usage.hidden) {
      return
    }

    const keys = new Set([...rows.map(row => row.key), ...(context === undefined ? [] : [CONTEXT_KEY])])
    for (const [key, meter] of meterByKey) {
      if (!keys.has(key)) {
        meter.node.remove()
        meterByKey.delete(key)
      }
    }

    usageHead.hidden = !hasPlanPart
    if (rows.length > 0) {
      const freshest = Math.max(...rows.map(row => row.at))
      setText(usageFresh, `${shortAgo(now - freshest)}更新`)
      usageFresh.title = [
        ...usageData.list.map(
          window => `${window.label}：${window.source === 'plan' ? '用量查詢' : '回覆附帶'}，${clockOf(window.at)}`,
        ),
        '',
        '同一段期間內用量只會增加，所以每一項取兩個來源裡較高的讀數：',
        `・用量查詢＝${SOURCE_TEXT.plan}`,
        `・回覆附帶＝${SOURCE_TEXT.response}`,
        '換帳號或期間重置後，舊的讀數會立刻作廢。',
      ].join('\n')
    } else {
      setText(usageFresh, '等待額度讀數')
      usageFresh.title = ''
    }
    for (const row of rows) {
      drawMeter(meterFor(row.key), row)
    }

    usageNote.hidden = !isNoteShown
    if (isNoteShown) {
      setText(usageNote, problem.text)
      usageNote.title = problem.detail
    }

    const extra = usageData.extra
    usageExtra.hidden = !extra
    if (extra) {
      const used = extra.usedCredits === null ? '—' : money(extra.usedCredits, extra.currency)
      const limit = extra.monthlyLimit === null ? '' : ` / ${money(extra.monthlyLimit, extra.currency)}`
      const share = extra.percent === null ? '' : `（${Math.round(extra.percent)}%）`
      setText(usageExtra, `額外用量 ${used}${limit}${share}`)
    }

    contextHead.hidden = context === undefined
    if (context !== undefined) {
      const className = `usage-head is-sub${hasPlanPart ? ' is-divided' : ''}`
      if (contextHead.className !== className) {
        contextHead.className = className
      }
      setText(contextTitle, isCurrentFocused ? '目前對話' : '最近活動的對話')
      contextTitle.title = isCurrentFocused
        ? '跟著你目前（或最後）點開的 Claude 分頁'
        : '還沒對上任何 Claude 分頁，先固定顯示最近有動作的對話；點一下 Claude 分頁，就會改成跟著它'
      setText(contextName, nameOf(current))
      contextName.title = [nameOf(current), String(current.cwd || ''), modelOf(current.model)].filter(Boolean).join('\n')
      drawMeter(meterFor(CONTEXT_KEY), {
        label: '上下文',
        percent: context.percent,
        foot: `${formatTokens(context.tokens)} / ${formatTokens(context.window)}`,
        title: [
          `上下文已用 ${formatInt(context.tokens)} / ${formatInt(context.window)} token（${Math.round(context.percent)}%）`,
          context.isEstimate
            ? '和 /context 同一種算法：上一次回應的用量，加上之後新加入的內容（估算）'
            : '上一次回應時的用量（這次沒拿到 /context 的估算）',
        ].join('\n'),
      })
    }

    const wanted = [
      usageHead,
      ...rows.map(row => meterByKey.get(row.key).node),
      usageNote,
      usageExtra,
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
    const parts = [`開始 ${clockOf(agent.startedAt)}`]
    if (agent.endedAt) {
      parts.push(`結束 ${clockOf(agent.endedAt)}`)
    }
    parts.push(agent.type, `${agent.steps} 步`)
    parts.push(`${nameOf(session)} · ${modelOf(session.model)}`)

    return `${agent.label}\n${parts.join(' · ')}\n按一下查看任務細節`
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

  /** Running cards: healthy ones under 執行中, quiet or lost ones under 需要你. */
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
      const metaText = `${STATE_LABEL[state]} · ${typeLabel(agent.type)} · ${agent.steps} 步`
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
          ? '超過 1 分鐘沒有回報，對話可能已中斷'
          : state === 'quiet'
            ? `${Math.floor((now - agent.lastAt) / 60_000)} 分鐘沒有新動作，可能在長時間思考`
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
        ? activity.reason || '等你回覆'
        : activity.state === 'working'
          ? '工作中'
          : `閒置 · ${shortAgo(now - activity.since)}做完這一輪`
    const body = el('span', 'meta body')
    if (isCurrent) {
      const mark = el('span', 'tag is-lead is-current', '目前')
      mark.title = '上方的「上下文」量表顯示的就是這個對話'
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
      const figure = el('span', `ctx end ${levelOf(context.percent)}`.trim(), `上下文 ${Math.round(context.percent)}%`)
      figure.title = `上下文已用 ${formatInt(context.tokens)} / ${formatInt(context.window)} token`
      meta.append(figure)
    }
    row.append(head, meta)

    return row
  }

  /** The 需要你 section: waiting sessions (redrawn each second: their wait time ticks), troubled cards, recent failures. */
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
      body.append(agent.tokens ? tokenBar(agent.tokens) : el('span', 'note', `完成 · ${agent.steps} 步 · 沒有 token 紀錄`))
    } else if (agent.status === 'failed') {
      const note = el('span', 'note', `失敗 · 最後一步：${agent.lastAction || '—'}`)
      note.title = agent.lastAction || ''
      body.append(note)
    } else {
      body.append(el('span', 'note', `已中止 · ${agent.steps} 步`))
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
      more.append(el('span', 'note', `還有 ${list.length - SHOWN_ENDED} 個較早結束的子代理沒有列出`))
      rows.push(more)
    }
    endedList.replaceChildren(...rows)
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

    const title = sessions.length === 0 ? '還沒收到資料' : '目前沒有子代理'
    const sub =
      sessions.length === 0
        ? '請確認 Claude Code 已載入 agent-board mod：在 Claude 輸入 /agent-board，有回應就代表正常。'
        : '派出子代理後，這裡會即時顯示它們的進度。'
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
      usageData = message.usage && Array.isArray(message.usage.list) ? message.usage : { list: [] }
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
