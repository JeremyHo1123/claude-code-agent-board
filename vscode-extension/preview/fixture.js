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
    title: 'Reading notes',
    cwd: '/home/you/projects/notes',
    model: 'claude-opus-5-5',
    updatedAt: at(2),
    isClosed: false,
    activity: { state: 'waiting', since: at(134), reason: 'needs your OK for Bash', kind: 'permission' },
    usage: context(34),
    agents: [
      { id: 'a1f3c9d2e7', label: 'Search papers from this week', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(161), lastAt: at(3), steps: 14, lastAction: 'WebSearch "gaussian splatting avatars 2026"' },
      { id: 'b72e01aa43', label: 'Search industry news', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(159), lastAt: at(1), steps: 9, lastAction: 'WebFetch https://example.com/news/ai' },
      { id: 'c9d0e4ff12', label: 'Look up papers in other fields', type: 'Explore', isListed: true, status: 'running', startedAt: at(402), lastAt: at(190), steps: 6, lastAction: 'Read concepts/diffusion-policy.md' },
      { id: 'd4417be093', label: 'Wiki duplicate check', type: 'general-purpose', isListed: true, status: 'done', startedAt: at(900), lastAt: at(781), endedAt: at(781), steps: 11, lastAction: 'Grep "Gaussian Splatting"', tokens: { input: 1_200, output: 4_100, cacheRead: 290_000, cacheWrite: 17_000 } },
      { id: 'e0aa98c311', label: 'Download arXiv PDFs', type: 'general-purpose', isListed: true, status: 'failed', startedAt: at(1300), lastAt: at(1241), endedAt: at(1241), steps: 3, lastAction: 'Bash curl -sL https://arxiv.org/pdf/0000.00000 -o paper.pdf' },
      { id: 'a05ee5a6a5', label: 'verify:sources', type: 'workflow', isListed: false, status: 'stopped', startedAt: at(2000), lastAt: at(1900), endedAt: at(1900), steps: 5, lastAction: 'Glob wiki/**/*nerf*.md', workflow: { runId: 'wf_1', name: 'paper-survey', phase: 'Verify' } },
    ],
  }

  const rewrite = {
    version: 1,
    sessionId: 'session-d',
    title: 'Rewrite the weekly report script in TypeScript and add tests',
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
    title: 'Meeting notes',
    cwd: '/home/you/projects/team-wiki',
    model: 'claude-sonnet-5-5',
    updatedAt: at(4),
    isClosed: false,
    activity: { state: 'working', since: at(212) },
    usage: context(21, 200_000),
    agents: [
      { id: 'f1c2d3e4a5', label: 'Gather the to-dos', type: 'general-purpose', isListed: true, status: 'running', startedAt: at(48), lastAt: at(4), steps: 4, lastAction: 'Grep "TODO" in meetings/' },
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

  /**
   * The message the board gets: { multi, empty, error (the shared read refused), fallback (no Claude
   * tab matched), accounts (a second account's sessions are open too) }.
   */
  window.previewBoard = function (options) {
    const planAt = options.error ? at(260) : at(12)
    const source = options.error ? 'plan' : 'response'
    const usage = {
      list: [
        { key: 'five_hour', label: '5-hour session', percent: 62, resetsAt: iso(2.2), at: options.error ? planAt : at(3), source },
        { key: 'seven_day', label: 'Weekly · all models', percent: 18, resetsAt: iso(86.4), at: options.error ? planAt : at(3), source },
        { key: 'seven_day_sonnet', label: 'Weekly · Sonnet', percent: 4, resetsAt: iso(86.4), at: planAt, source: 'plan' },
        { key: 'seven_day_opus', label: 'Weekly · Opus', percent: 74, resetsAt: iso(86.4), at: planAt, source: 'plan' },
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
    // a second sign-in on the same machine: its own windows, its own shared read
    const other = {
      id: 'b2c3d4e5f6a7',
      label: 'team@example.com',
      isCurrent: false,
      sessions: ['Meeting notes'],
      list: [
        { key: 'five_hour', label: '5-hour session', percent: 8, resetsAt: iso(2.2), at: at(41), source: 'response' },
        { key: 'seven_day', label: 'Weekly · all models', percent: 83, resetsAt: iso(31.5), at: at(41), source: 'response' },
      ],
      planAt: at(41),
    }
    const mine = { id: 'a1b2c3d4e5f6', label: 'you@example.com', isCurrent: true, sessions: sessions.map(session => session.title || 'website'), ...usage }

    return {
      type: 'data',
      sessions,
      usage: options.accounts ? { ...usage, accounts: [mine, other] } : usage,
      prompts: {
        sessionId: options.multi ? 'session-d' : 'session-a',
        list: [
          'Rewrite the weekly report script in TypeScript; leave the tests alone for now',
          'Why does parseDate return undefined here',
          'OK, then add time zone tests too: one set for Taipei and one for UTC, and cover the case that crosses midnight',
          'ok',
          'Run all the tests once and show me the results',
        ].map((head, index) => ({ at: at(3_000 - index * 540), head })),
      },
      currentSessionId: options.multi ? 'session-d' : 'session-a',
      isCurrentFocused: !options.fallback,
    }
  }

  // ── one agent's detail ───────────────────────────────────────────

  const start = at(161)
  const NO_RESULT = '(the sample data holds no result for this step)'
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
          result: (extra && extra.result) || NO_RESULT,
          resultTotal: ((extra && extra.result) || NO_RESULT).length,
        }),
  })

  const running = {
    key: 'session-a:a1f3c9d2e7',
    sessionId: 'session-a',
    agentId: 'a1f3c9d2e7',
    status: 'running',
    agent: { id: 'a1f3c9d2e7', label: 'Search papers from this week', type: 'general-purpose', status: 'running', startedAt: start, steps: 7 },
    session: { name: 'Reading notes' },
    meta: { agentType: 'general-purpose', description: 'Search papers from this week' },
    transcript: {
      prompt:
        'Search for papers from the past 7 days on 3D generation and robot learning.\n\nRequirements:\n1. For each paper, give the title, the arXiv number and its point in one line\n2. Only papers with code or a project page\n3. Skip those already in the wiki (first Grep wiki/ for a page of the same name)\n\nReport: a markdown table, grouped by topic.',
      model: 'claude-opus-5-5',
      startedAt: start,
      lastAt: at(3),
      events: [
        { kind: 'text', at: start + 2000, text: 'First, see which gaussian splatting pages the wiki already has, so nothing is repeated.' },
        step('t1', 'Grep', 'gaussian splatting · …/projects/notes/wiki', 3, 0.4, {
          input: '{\n  "pattern": "gaussian splatting",\n  "path": "wiki",\n  "-i": true\n}',
          result: 'wiki/concepts/gaussian-splatting.md\nwiki/entities/large-reconstruction-model.md\nwiki/entities/surfel-splatting.md',
        }),
        step('t2', 'Read', '…/wiki/concepts/gaussian-splatting.md', 5, 0.2, {
          input: '{\n  "file_path": "/home/you/projects/notes/wiki/concepts/gaussian-splatting.md",\n  "limit": 80\n}',
          result: '1 ---\n2 title: Gaussian Splatting\n3 type: concept\n4 status: active\n5 ---\n6\n7 # Gaussian Splatting\n8\n9 A scene as 3D Gaussian ellipsoids, rendered in real time…',
        }),
        step('t3', 'WebSearch', 'gaussian splatting avatars 2026 arxiv', 9, 3.8),
        step('t4', 'Bash', 'Fetch the arXiv listing', 18, 1.1, {
          input: 'curl -sL "http://export.arxiv.org/api/query?search_query=cat:cs.CV" -o list.xml',
          isError: true,
          result: 'curl: (56) Recv failure: Connection was reset',
        }),
        { kind: 'text', at: start + 21000, text: 'The arXiv API connection was reset; trying https, writing to a file first and checking its size.' },
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
    '## Picks of the week (4 papers; 3 already in the wiki left out)\n\n' +
    '### 3D generation\n\n' +
    '| Paper | arXiv | Point |\n|---|---|---|\n' +
    '| AvatarSplat | 0000.00001 | An animatable **Gaussian** head avatar from one photo |\n' +
    '| FlowSplat | 0000.00002 | Gaussian parameters generated directly by flow matching |\n\n' +
    '### Robot learning\n\n' +
    '- **WholeBodyDP**: diffusion policy for whole-body control, with `sim2real` code\n' +
    '- **LiteVLA**: a VLA shrunk to 1B parameters, with latency down to 40 ms\n\n' +
    '> Note: the first arXiv API connection failed; fetched again over https, and the list is complete.\n\n' +
    '```bash\ncurl -sL "https://export.arxiv.org/api/query?..." -o list.xml\n```'

  /** The detail message's data: the agent mid-run, or ended with its report. */
  window.previewDetail = function (isDone) {
    if (!isDone) {
      return running
    }
    const events = running.transcript.events.map(event =>
      event.kind === 'tool' && event.endAt === undefined
        ? { ...event, endAt: event.at + 2600, isError: false, result: NO_RESULT, resultTotal: NO_RESULT.length }
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
