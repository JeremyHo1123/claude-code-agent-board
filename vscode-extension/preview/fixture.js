// Made-up data for the preview pages: what the extension would post to its webviews.
// Nothing here comes from a real session.
;(function () {
  'use strict'

  const now = Date.now()
  const at = seconds => now - seconds * 1000
  const iso = hours => new Date(now + hours * 3_600_000).toISOString()
  const context = (percent, window = 1_000_000) => ({
    contextPercent: percent,
    contextTokens: Math.round((percent / 100) * window),
    contextWindow: window,
    isContextEstimate: true,
  })

  // ── the board ────────────────────────────────────────────────────

  const notes = {
    version: 1,
    sessionId: 'session-a',
    title: '整理讀書筆記',
    cwd: '/home/you/projects/notes',
    model: 'claude-opus-5-5',
    updatedAt: at(2),
    isClosed: false,
    activity: { state: 'waiting', since: at(134), reason: '等你允許 Bash', kind: 'permission' },
    usage: context(34),
    agents: [
      { id: 'a1f3c9d2e7', label: '搜尋本週論文', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(161), lastAt: at(3), steps: 14, lastAction: 'WebSearch "gaussian splatting avatars 2026"' },
      { id: 'b72e01aa43', label: '搜尋產業新聞', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(159), lastAt: at(1), steps: 9, lastAction: 'WebFetch https://example.com/news/ai' },
      { id: 'c9d0e4ff12', label: '查其他領域的論文', type: 'Explore', isListed: true, status: 'running', startedAt: at(402), lastAt: at(190), steps: 6, lastAction: 'Read concepts/diffusion-policy.md' },
      { id: 'd4417be093', label: 'wiki 查重', type: 'general-purpose', isListed: true, status: 'done', startedAt: at(900), lastAt: at(781), endedAt: at(781), steps: 11, lastAction: 'Grep "Gaussian Splatting"', tokens: { input: 1_200, output: 4_100, cacheRead: 290_000, cacheWrite: 17_000 } },
      { id: 'e0aa98c311', label: '下載 arXiv PDF', type: 'general-purpose', isListed: true, status: 'failed', startedAt: at(1300), lastAt: at(1241), endedAt: at(1241), steps: 3, lastAction: 'Bash curl -sL https://arxiv.org/pdf/0000.00000 -o paper.pdf' },
      { id: 'a05ee5a6a5', label: 'verify:sources', type: 'workflow', isListed: false, status: 'stopped', startedAt: at(2000), lastAt: at(1900), endedAt: at(1900), steps: 5, lastAction: 'Glob wiki/**/*nerf*.md', workflow: { runId: 'wf_1', name: 'paper-survey', phase: '驗證' } },
    ],
  }

  const rewrite = {
    version: 1,
    sessionId: 'session-d',
    title: '把週報腳本改寫成 TypeScript 並補上測試',
    cwd: '/home/you/projects/notes',
    model: 'claude-opus-5-5',
    updatedAt: at(1),
    isClosed: false,
    activity: { state: 'working', since: at(95) },
    usage: context(78),
    agents: [],
  }

  const meeting = {
    version: 1,
    sessionId: 'session-b',
    title: '整理會議紀錄',
    cwd: '/home/you/projects/team-wiki',
    model: 'claude-sonnet-5-5',
    updatedAt: at(4),
    isClosed: false,
    activity: { state: 'working', since: at(212) },
    usage: context(21, 200_000),
    agents: [
      { id: 'f1c2d3e4a5', label: '彙整待辦事項', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(48), lastAt: at(4), steps: 4, lastAction: 'Grep "TODO" in meetings/' },
    ],
  }

  const website = {
    version: 1,
    sessionId: 'session-c',
    cwd: '/home/you/projects/website',
    model: 'claude-opus-5-5',
    updatedAt: at(20),
    isClosed: false,
    activity: { state: 'idle', since: at(330) },
    usage: context(9),
    agents: [],
  }

  /** The message the board gets: { multi, empty, error (the shared read refused), fallback (no Claude tab matched) }. */
  window.previewBoard = function (options) {
    const planAt = options.error ? at(260) : at(12)
    const source = options.error ? 'plan' : 'response'
    const usage = {
      list: [
        { key: 'five_hour', label: '5 小時工作階段', percent: 62, resetsAt: iso(2.2), at: options.error ? planAt : at(3), source },
        { key: 'seven_day', label: '每週・所有模型', percent: 18, resetsAt: iso(86.4), at: options.error ? planAt : at(3), source },
        { key: 'seven_day_sonnet', label: '每週・Sonnet', percent: 4, resetsAt: iso(86.4), at: planAt, source: 'plan' },
        { key: 'seven_day_opus', label: '每週・Opus', percent: 74, resetsAt: iso(86.4), at: planAt, source: 'plan' },
      ],
      extra: { percent: 24.6, usedCredits: 1230, monthlyLimit: 5000, currency: 'USD' },
      planAt,
      ...(options.error ? { planError: { at: at(40), status: 429 }, planNextAt: now + 80_000 } : {}),
    }
    const sessions = options.empty
      ? [{ ...notes, agents: [], activity: { state: 'idle', since: at(60) } }]
      : options.multi
        ? [notes, rewrite, meeting, website]
        : [notes]

    return {
      type: 'data',
      sessions,
      usage,
      currentSessionId: options.multi ? 'session-d' : 'session-a',
      isCurrentFocused: !options.fallback,
    }
  }

  // ── one agent's detail ───────────────────────────────────────────

  const start = at(161)
  const step = (id, name, summary, offset, took, extra) => ({
    kind: 'tool',
    id,
    name,
    summary,
    input: extra && extra.input !== undefined ? extra.input : JSON.stringify({ query: summary }, null, 2),
    at: start + offset * 1000,
    ...(took === undefined
      ? {}
      : {
          endAt: start + (offset + took) * 1000,
          isError: Boolean(extra && extra.isError),
          result: (extra && extra.result) || '（範例資料沒有附上這一步的結果）',
          resultTotal: ((extra && extra.result) || '（範例資料沒有附上這一步的結果）').length,
        }),
  })

  const running = {
    key: 'session-a:a1f3c9d2e7',
    sessionId: 'session-a',
    agentId: 'a1f3c9d2e7',
    status: 'running',
    agent: { id: 'a1f3c9d2e7', label: '搜尋本週論文', type: 'general-purpose', status: 'running', startedAt: start, steps: 7 },
    session: { name: '整理讀書筆記' },
    meta: { agentType: 'general-purpose', description: '搜尋本週論文' },
    transcript: {
      prompt:
        '搜尋過去 7 天與 3D 生成、機器人學習相關的論文。\n\n要求：\n1. 每篇給標題、arXiv 編號、一句話重點\n2. 只收有程式碼或專案頁的\n3. 已在 wiki 裡的跳過（先用 Grep 查 wiki/ 有沒有同名頁）\n\n回報格式：markdown 表格，依主題分組。',
      model: 'claude-opus-5-5',
      startedAt: start,
      lastAt: at(3),
      events: [
        { kind: 'text', at: start + 2000, text: '先查 wiki 裡已經有哪些 gaussian splatting 相關頁面，避免重複。' },
        step('t1', 'Grep', 'gaussian splatting · …/projects/notes/wiki', 3, 0.4, {
          input: '{\n  "pattern": "gaussian splatting",\n  "path": "wiki",\n  "-i": true\n}',
          result: 'wiki/concepts/gaussian-splatting.md\nwiki/entities/large-reconstruction-model.md\nwiki/entities/surfel-splatting.md',
        }),
        step('t2', 'Read', '…/wiki/concepts/gaussian-splatting.md', 5, 0.2, {
          input: '{\n  "file_path": "/home/you/projects/notes/wiki/concepts/gaussian-splatting.md",\n  "limit": 80\n}',
          result: '1 ---\n2 title: Gaussian Splatting\n3 type: concept\n4 status: active\n5 ---\n6\n7 # Gaussian Splatting\n8\n9 以 3D 高斯橢球表示場景，可即時渲染…',
        }),
        step('t3', 'WebSearch', 'gaussian splatting avatars 2026 arxiv', 9, 3.8),
        step('t4', 'Bash', 'Fetch the arXiv listing', 18, 1.1, {
          input: 'curl -sL "http://export.arxiv.org/api/query?search_query=cat:cs.CV" -o list.xml',
          isError: true,
          result: 'curl: (56) Recv failure: Connection was reset',
        }),
        { kind: 'text', at: start + 21000, text: 'arXiv API 連線被重設，改用 https 並先寫檔再驗大小。' },
        step('t5', 'Bash', 'Fetch the arXiv listing over https', 24, 2.6, {
          input: 'curl -sL "https://export.arxiv.org/api/query?search_query=cat:cs.CV" -o list.xml && wc -c list.xml',
          result: '48213 list.xml',
        }),
        step('t6', 'WebFetch', 'https://arxiv.org/abs/0000.00001', 31, 4.2),
        step('t7', 'WebSearch', 'diffusion policy humanoid 2026', 152),
      ],
      eventsDropped: 0,
      toolCount: 7,
      errorCount: 1,
      usage: { input: 1_200, output: 4_100, cacheRead: 290_000, cacheWrite: 17_000 },
      thinkingMs: 41_000,
      output: undefined,
      truncated: false,
    },
    missing: false,
  }

  const report =
    '## 本週焦點（4 篇，已排除 wiki 既有 3 篇）\n\n' +
    '### 3D 生成\n\n' +
    '| 論文 | arXiv | 重點 |\n|---|---|---|\n' +
    '| AvatarSplat | 0000.00001 | 單張照片生成可動的 **Gaussian** 頭像 |\n' +
    '| FlowSplat | 0000.00002 | 用 flow matching 直接生成高斯參數 |\n\n' +
    '### 機器人學習\n\n' +
    '- **WholeBodyDP**：diffusion policy 用在全身控制，附 `sim2real` 程式碼\n' +
    '- **LiteVLA**：把 VLA 壓到 1B 參數，延遲降到 40 ms\n\n' +
    '> 注意：arXiv API 第一次連線失敗，已改用 https 重抓，清單完整。\n\n' +
    '```bash\ncurl -sL "https://export.arxiv.org/api/query?..." -o list.xml\n```'

  /** The detail message's data: the agent mid-run, or ended with its report. */
  window.previewDetail = function (isDone) {
    if (!isDone) {
      return running
    }
    const events = running.transcript.events.map(event =>
      event.kind === 'tool' && event.endAt === undefined
        ? { ...event, endAt: event.at + 2600, isError: false, result: '（範例資料沒有附上這一步的結果）', resultTotal: 17 }
        : event,
    )

    return {
      ...running,
      status: 'done',
      agent: { ...running.agent, status: 'done', endedAt: now - 2_000 },
      transcript: { ...running.transcript, events, output: { via: 'handback', text: report, total: report.length } },
    }
  }

  /** The board's data with that agent ended, so the board's own row agrees with the ended detail. */
  window.previewBoardDone = function (options) {
    const message = window.previewBoard(options)
    for (const session of message.sessions) {
      session.agents = session.agents.map(agent =>
        agent.id === 'a1f3c9d2e7' ? { ...agent, status: 'done', endedAt: now - 2_000, steps: 7, tokens: running.transcript.usage } : agent,
      )
    }

    return message
  }
})()
