import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { boardRootOf, describeCall, formatElapsed, formatTokens, parsePlanUsage } from '../hooks/format'

/** The home folder every test's session reports: the board's files land under its .claude/agent-board. */
const HOME = '/home/tester'

/**
 * A path as the tests compare it: the engine hands fs calls the platform's spelling, so on Windows
 * `/home/tester` arrives with backslashes and a drive letter.
 */
const pathKey = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const PLAN_BODY = {
  five_hour: { utilization: 62, resets_at: '2026-10-05T12:00:00Z' },
  seven_day: { utilization: 18.5, resets_at: '2026-10-09T03:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 4, resets_at: null },
  model_scoped: [{ display_name: 'Fable', utilization: 9, resets_at: '2026-10-09T03:00:00Z' }],
  extra_usage: { is_enabled: true, monthly_limit: 5_000, used_credits: 1_230, utilization: 24.6, currency: 'USD' },
}

test('the plan usage body reads into windows, and junk reads as none', async () => {
  const plan = parsePlanUsage(PLAN_BODY, 42)
  expect(plan?.fetchedAt).toBe(42)
  expect(plan?.windows.map(window => window.key)).toEqual(['five_hour', 'seven_day', 'seven_day_sonnet', 'model:Fable'])
  expect(plan?.windows[0]).toEqual({
    key: 'five_hour',
    label: '5 小時工作階段',
    percent: 62,
    resetsAt: '2026-10-05T12:00:00Z',
  })
  expect(plan?.windows[2]).toEqual({ key: 'seven_day_sonnet', label: '每週・Sonnet', percent: 4 })
  expect(plan?.extra).toEqual({ percent: 24.6, usedCredits: 1_230, monthlyLimit: 5_000, currency: 'USD' })
  expect(parsePlanUsage({ error: 'nope' }, 0)).toBeUndefined()
  expect(parsePlanUsage('not json', 0)).toBeUndefined()
  expect(parsePlanUsage({ five_hour: { utilization: '62' } }, 0)).toBeUndefined()
})

test('one read of the plan usage serves every session through the shared file, and a refusal backs off', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const PLAN_FILE = '/home/tester/.claude/agent-board/plan.json'
  const files = new Map<string, string>()
  const fetched: { url: string; auth?: string; beta?: string }[] = []
  /** While set, the endpoint answers 429, with this Retry-After when it has one. */
  let refusal: { retryAfter?: string } | undefined
  const keyOf = pathKey
  const shared = () => JSON.parse(files.get(PLAN_FILE) ?? '{}')
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.authorize', () => ({ value: { handle: 'handle-1', kind: 'bearer' } as const }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('http.fetch', ($, e) => {
    fetched.push({ url: e.url, auth: e.init?.auth, beta: e.init?.headers?.['anthropic-beta'] })

    const headers: Record<string, string> =
      refusal?.retryAfter === undefined ? {} : { 'retry-after': refusal.retryAfter }

    return {
      value: {
        status: refusal === undefined ? 200 : 429,
        ok: refusal === undefined,
        headers,
        text: refusal === undefined ? JSON.stringify(PLAN_BODY) : '',
      },
    }
  })
  on('fs.read', ($, e) => {
    const text = files.get(keyOf(e.path))

    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(keyOf(e.path), e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-9' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1_000, window: 1_000_000, percent: 0 }, rateLimits: [] },
  }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/work/project', surface: 'vscode', isInteractive: true })

  // no shared file yet: this session claims the read, makes it, and writes the answer back
  await clock.advance(1_000)
  expect(fetched).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'handle-1', beta: 'oauth-2025-04-20' }])
  expect(shared().plan.windows[0]).toMatchObject({ key: 'five_hour', percent: 62 })
  expect(shared().nextAttemptAt).toBe(131_000)

  // another session read just now: this one waits for the file's next time
  files.set(PLAN_FILE, JSON.stringify({ ...shared(), nextAttemptAt: 160_000 }))
  await clock.advance(50_000)
  expect(fetched.length).toBe(1)

  // due again: one more read
  await clock.advance(10_000)
  expect(fetched.length).toBe(2)

  // a refusal with Retry-After keeps the last good windows and holds everyone off for its five minutes
  refusal = { retryAfter: '300' }
  await clock.advance(31_000)
  expect(fetched.length).toBe(3)
  expect(shared().lastError).toMatchObject({ status: 429 })
  expect(shared().failures).toBe(1)
  expect(shared().plan.windows[0]).toMatchObject({ percent: 62 })
  await clock.advance(120_000)
  expect(fetched.length).toBe(3)

  // refusals without Retry-After wait longer each time in a row: the second one, two minutes
  refusal = {}
  await clock.advance(190_000)
  expect(fetched.length).toBe(4)
  expect(shared().failures).toBe(2)
  expect(shared().nextAttemptAt - shared().lastAttemptAt).toBe(120_000)

  // a success clears the streak and the error, and the usual interval resumes
  refusal = undefined
  await clock.advance(125_000)
  expect(fetched.length).toBe(5)
  expect(shared().failures).toBeUndefined()
  expect(shared().lastError).toBeUndefined()
  expect(shared().nextAttemptAt - shared().lastAttemptAt).toBe(30_000)
})

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: '子代理進度',
    isFocused: false,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Search this week for CVPR papers',
  description: '頂會焦點論文搜尋',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

test('a spawned subagent shows as running, then done with its tokens, then clears', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } as const }))
  on('agent.list', () => ({ value: [] }))

  await $.agent.spawn(SPAWN)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /頂會焦點論文搜尋/ }))?.text).toBe('● 頂會焦點論文搜尋')
    expect(await ui.find({ type: 'Text', text: /general-purpose · 0 步 · 最近：啟動中/ })).toBeDefined()
    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    await ui.unmount()
  }

  await clock.advance(65_000)
  await $.turn.complete({
    answer: 'found 12 papers',
    durationMs: 65_000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: {
      input_tokens: 1_200,
      output_tokens: 800,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 2_000,
      model: 'claude-opus-5-5',
    },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /頂會焦點論文搜尋/ }))?.text).toBe('✓ 頂會焦點論文搜尋')
  expect(await ui.find({ type: 'Text', text: '1:05' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /token 34k（快取讀取 30k）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 執行中 · 1 已結束/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /頂會焦點論文搜尋/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /還沒有子代理/ })).toBeDefined()
  await ui.unmount()
})

test('an interrupted subagent shows as stopped', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-2' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } as const }))
  on('agent.list', () => ({ value: [] }))

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: '產業新聞搜尋' })
  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: true,
    turnId: 'turn-2',
    agentId: 'agent-2',
    reason: 'aborted',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /產業新聞搜尋/ }))?.text).toBe('■ 產業新聞搜尋')
  expect(await ui.find({ type: 'Text', text: /已中止/ })).toBeDefined()
  await ui.unmount()
})

test('two running subagents open the pane; the periodic check settles a killed one', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  const listed: AgentInfo[] = []
  let opened = 0
  let registered = ''
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    registered = e.name

    return { value: { command: e.name } }
  })
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.tool_use_id === 'toolu_a' ? 'agent-a' : 'agent-b' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => {
    opened += 1

    return { value: { isPlaced: true } as const }
  })
  on('agent.list', () => ({ value: listed }))

  await $.session.start({ cwd: '/work/project', surface: 'vscode', isInteractive: true })
  expect(registered).toBe('agent-board')

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_a', description: 'A' })
  await clock.advance(0)
  expect(opened).toBe(0)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_b', description: 'B' })
  await clock.advance(0)
  expect(opened).toBe(1)

  listed.push({ id: 'agent-a', description: 'A', type: 'general-purpose', status: 'killed' })
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /^. A$/ }))?.text).toBe('■ A')
  expect((await ui.find({ type: 'Text', text: /^. B$/ }))?.text).toBe('● B')
  expect(await ui.find({ type: 'Text', text: /1 執行中 · 1 已結束/ })).toBeDefined()
  await ui.unmount()
})

test('each session writes the JSON snapshot the VS Code extension reads', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const written: { path: string; text: string }[] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  // asked for /context's summary, the engine adds the breakdown: the snapshot takes its estimate
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 318_500,
        window: 1_000_000,
        percent: 32,
        ...(e.breakdown === 'summary' ? { breakdown: { totalTokens: 341_000, rawMaxTokens: 1_000_000, percentage: 34 } } : {}),
      },
      rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-05T10:00:00Z' }],
    } as never,
  }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-3' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } as const }))
  on('agent.list', () => ({ value: [] }))

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_3', description: 'wiki 查重' })
  expect(pathKey(written.at(-1)?.path ?? '')).toBe('/home/tester/.claude/agent-board/sessions/session-1.json')
  const started = JSON.parse(written.at(-1)?.text ?? '{}')
  expect(started).toMatchObject({ sessionId: 'session-1', cwd: '/work/project', isClosed: false })
  expect(started.agents[0]).toMatchObject({ label: 'wiki 查重', status: 'running', steps: 0, lastAction: '啟動中' })
  expect(started.usage).toMatchObject({
    contextPercent: 34,
    contextTokens: 341_000,
    isContextEstimate: true,
    rateLimits: [{ kind: 'five_hour', percentUsed: 62 }],
  })

  await clock.advance(30_000)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 30_000,
    isAborted: false,
    turnId: 'turn-3',
    agentId: 'agent-3',
    reason: 'answer',
  })
  const ended = JSON.parse(written.at(-1)?.text ?? '{}')
  expect(ended.agents[0]).toMatchObject({ status: 'done', startedAt: 0, endedAt: 30_000 })
})

test("the session's activity follows its turns, questions and permission dialogs", async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const written: string[] = []
  let answer: (() => void) | undefined
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.authorize', () => ({ value: null }))
  on('fs.write', ($, e) => {
    written.push(e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-a' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await new Promise<void>(resolve => {
      answer = resolve
    })

    return { result: { answers: {} } }
  })
  on('classic.PermissionRequest', () => ({}))
  const activity = () => JSON.parse(written.at(-1) ?? '{}').activity

  await $.session.start({ cwd: '/work/project', surface: 'vscode', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'working' })

  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which one?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      },
    ],
  })
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'waiting', kind: 'question', reason: '問你問題' })
  answer?.()
  await asking
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'working' })

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'waiting', kind: 'permission', reason: '等你允許 Bash' })

  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'idle' })
})

test('the formatting helpers', async () => {
  expect(describeCall({ tool: 'Read', file_path: 'C:\\Users\\tester\\vault\\wiki\\concepts\\ddpm.md' })).toBe('Read concepts/ddpm.md')
  // the board's folder: under Claude Code's own, wherever the home folder is spelled
  expect(boardRootOf(undefined, 'C:\\Users\\tester', undefined)).toBe('C:/Users/tester/.claude/agent-board')
  expect(boardRootOf(undefined, undefined, '/home/tester/')).toBe('/home/tester/.claude/agent-board')
  expect(boardRootOf('D:\\claude-config\\', 'C:\\Users\\tester', '/home/tester')).toBe('D:/claude-config/agent-board')
  expect(boardRootOf('  ', '', undefined)).toBeUndefined()
  expect(describeCall({ tool: 'Grep', pattern: 'diffusion policy' })).toBe('Grep "diffusion policy"')
  expect(describeCall({ tool: 'Bash', command: 'wc -c   index.md' })).toBe('Bash wc -c index.md')
  expect(describeCall({ tool: 'mcp__arxiv__search_papers', query: 'x' })).toBe('arxiv__search_papers')
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(34_000)).toBe('34k')
  expect(formatTokens(1_250_000)).toBe('1.3M')
  expect(formatElapsed(65_000)).toBe('1:05')
  expect(formatElapsed(3_725_000)).toBe('1:02:05')
})
