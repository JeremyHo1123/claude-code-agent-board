import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  boardRootOf,
  describeCall,
  fillBar,
  fillTone,
  formatElapsed,
  formatTokens,
  isAnotherAccountsWeek,
  parseAccount,
  parsePlanUsage,
  planFileOf,
  weekEndOf,
} from '../hooks/format'

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
    label: '5-hour session',
    percent: 62,
    resetsAt: '2026-10-05T12:00:00Z',
  })
  expect(plan?.windows[2]).toEqual({ key: 'seven_day_sonnet', label: 'Weekly · Sonnet', percent: 4 })
  expect(plan?.extra).toEqual({ percent: 24.6, usedCredits: 1_230, monthlyLimit: 5_000, currency: 'USD' })
  expect(parsePlanUsage({ error: 'nope' }, 0)).toBeUndefined()
  expect(parsePlanUsage('not json', 0)).toBeUndefined()
  expect(parsePlanUsage({ five_hour: { utilization: '62' } }, 0)).toBeUndefined()
})

test("the band's bar fills in proportion, inside its width, and warms as it fills", async () => {
  expect(fillBar(34, 10)).toBe('███░░░░░░░')
  expect(fillBar(0, 5)).toBe('░░░░░')
  expect(fillBar(100, 5)).toBe('█████')
  // a figure past either end stays inside the bar
  expect(fillBar(130, 4)).toBe('████')
  expect(fillBar(-5, 4)).toBe('░░░░')
  expect(fillBar(50, 0)).toBe('█')
  expect(fillTone(69)).toBe('success')
  expect(fillTone(70)).toBe('warning')
  expect(fillTone(90)).toBe('error')
})

/** What the profile endpoint answers: whose credential the session holds. */
const PROFILE_BODY = {
  account: { uuid: '11111111-2222-3333-4444-555555555555', email: 'tester@example.com', display_name: 'Tester' },
  organization: { uuid: '0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9', name: "tester@example.com's Organization" },
}

test('the profile body reads into an account, which names the shared file', async () => {
  // the organization's id (the limits are its), short and safe in a file name; the email to show
  expect(parseAccount(PROFILE_BODY)).toEqual({ id: '0a1b2c3d4e5f', label: 'tester@example.com' })
  expect(parseAccount({ account: { uuid: 'ABCDEF01-2345', display_name: 'Tester' } })).toEqual({ id: 'abcdef012345', label: 'Tester' })
  expect(parseAccount({ organization: { uuid: '0a1b2c3d' } })).toEqual({ id: '0a1b2c3d' })
  expect(parseAccount({ account: { email: 'tester@example.com' } })).toBeUndefined()
  expect(parseAccount('not json')).toBeUndefined()
  expect(planFileOf({ id: '0a1b2c3d4e5f' })).toBe('plan-0a1b2c3d4e5f.json')
  expect(planFileOf(undefined)).toBe('plan.json')
})

test("another account's week: one that ends elsewhere while the earlier week still runs", async () => {
  expect(weekEndOf(parsePlanUsage(PLAN_BODY, 0))).toBe('2026-10-09T03:00:00Z')
  expect(weekEndOf(undefined)).toBeUndefined()
  const week = '2026-10-09T03:00:00Z'
  const before = Date.parse(week) - 86_400_000
  expect(isAnotherAccountsWeek(week, '2026-10-08T12:00:00Z', before)).toBe(true)
  // the same week read again: its end wanders by a second
  expect(isAnotherAccountsWeek(week, '2026-10-09T02:59:59.596Z', before)).toBe(false)
  // the week ended: the next one ends a week later, the same account
  expect(isAnotherAccountsWeek(week, '2026-10-16T03:00:00Z', Date.parse(week) + 1_000)).toBe(false)
  expect(isAnotherAccountsWeek(week, '2026-10-16T03:00:00Z', Date.parse(week) - 60_000)).toBe(false)
  // nothing known on either side says nothing
  expect(isAnotherAccountsWeek(undefined, week, before)).toBe(false)
  expect(isAnotherAccountsWeek(week, undefined, before)).toBe(false)
})

test('one read of the plan usage serves every session of the account through its shared file, and a refusal backs off', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const PLAN_FILE = '/home/tester/.claude/agent-board/plan-0a1b2c3d4e5f.json'
  const files = new Map<string, string>()
  /** The profile endpoint's requests, apart from the usage reads the test counts. */
  const asked: { url: string; auth?: string }[] = []
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
    if (e.url.endsWith('/api/oauth/profile')) {
      asked.push({ url: e.url, auth: e.init?.auth })

      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(PROFILE_BODY) } }
    }
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

  // no shared file yet: this session learns its account, claims that account's read, makes it, and writes the answer back
  await clock.advance(1_000)
  expect(asked).toEqual([{ url: 'https://api.anthropic.com/api/oauth/profile', auth: 'handle-1' }])
  expect(fetched).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'handle-1', beta: 'oauth-2025-04-20' }])
  expect(shared().plan.windows[0]).toMatchObject({ key: 'five_hour', percent: 62 })
  expect(shared().nextAttemptAt).toBe(131_000)
  // the read and the session's snapshot both say whose usage it is; no file is shared across accounts
  expect(shared().account).toEqual({ id: '0a1b2c3d4e5f', label: 'tester@example.com' })
  expect(JSON.parse(files.get('/home/tester/.claude/agent-board/sessions/session-9.json') ?? '{}').account).toEqual({
    id: '0a1b2c3d4e5f',
    label: 'tester@example.com',
  })
  expect(files.has('/home/tester/.claude/agent-board/plan.json')).toBe(false)

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

/** A second sign-in, whose week ends at another time than the first one's. */
const OTHER_PROFILE = {
  account: { uuid: '66666666-7777-8888-9999-000000000000', email: 'other@example.com' },
  organization: { uuid: 'FEDCBA98-7654-3210-FEDC-BA9876543210' },
}
const OTHER_PLAN_BODY = {
  five_hour: { utilization: 7, resets_at: '2026-10-05T12:00:00Z' },
  seven_day: { utilization: 73, resets_at: '2026-10-08T12:00:00Z' },
}

/** A session whose credential can be moved to the other account mid-session, as /login does. */
function loginSetup(on: Parameters<TestBody>[1], refuseReads = false) {
  const files = new Map<string, string>()
  const state = {
    signedIn: 'tester' as 'tester' | 'other',
    rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.authorize', () => ({ value: { handle: 'handle-1', kind: 'bearer' } as const }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('http.fetch', ($, e) => {
    const isOther = state.signedIn === 'other'
    const isProfile = e.url.endsWith('/api/oauth/profile')
    const isRefused = refuseReads && !isProfile
    const headers: Record<string, string> = isRefused ? { 'retry-after': '3600' } : {}
    const body = isProfile ? (isOther ? OTHER_PROFILE : PROFILE_BODY) : isOther ? OTHER_PLAN_BODY : PLAN_BODY

    return { value: { status: isRefused ? 429 : 200, ok: !isRefused, headers, text: isRefused ? '' : JSON.stringify(body) } }
  })
  on('fs.read', ($, e) => {
    const text = files.get(pathKey(e.path))

    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(pathKey(e.path), e.text)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-9' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1_000, window: 1_000_000, percent: 0 }, rateLimits: state.rateLimits },
  }))
  on('agent.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))

  const BOARD = '/home/tester/.claude/agent-board'

  return {
    state,
    plan: (id: string) => JSON.parse(files.get(`${BOARD}/plan-${id}.json`) ?? '{}'),
    snapshot: () => JSON.parse(files.get(`${BOARD}/sessions/session-9.json`) ?? '{}'),
  }
}

test('a /login to another account moves the shared read to that account long before the recheck', async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  const { state, plan, snapshot } = loginSetup(on)
  await $.session.start({ cwd: '/work/project', surface: 'vscode', isInteractive: true })
  await clock.advance(1_000)
  expect(plan('0a1b2c3d4e5f').plan.windows[1]).toMatchObject({ key: 'seven_day', percent: 18.5 })
  expect(snapshot().account.id).toBe('0a1b2c3d4e5f')

  // the next read, through the other account's credential, answers with another week
  state.signedIn = 'other'
  await clock.advance(31_000)
  // it stays out of the first account's file, and the session asked at once whose it is now
  expect(plan('0a1b2c3d4e5f').plan.windows[1]).toMatchObject({ percent: 18.5 })
  expect(snapshot().account).toEqual({ id: 'fedcba987654', label: 'other@example.com' })
  // the next check reads into that account's own file
  await clock.advance(5_000)
  expect(plan('fedcba987654').plan.windows[1]).toMatchObject({ key: 'seven_day', percent: 73 })
  expect(plan('0a1b2c3d4e5f').plan.windows[1]).toMatchObject({ percent: 18.5 })
})

test("a /login shows in the session's own reply readings too: the snapshot names the new account", async ($, on) => {
  const clock = mock.clock(on, { now: 100_000 })
  // the shared read is held off for an hour: only the replies can tell
  const { state, snapshot } = loginSetup(on, true)
  state.rateLimits = [{ kind: 'seven_day', percentUsed: 18.5, resetsAt: '2026-10-09T03:00:00Z' }]
  await $.session.start({ cwd: '/work/project', surface: 'vscode', isInteractive: true })
  await clock.advance(1_000)
  expect(snapshot().account.id).toBe('0a1b2c3d4e5f')

  state.signedIn = 'other'
  state.rateLimits = [{ kind: 'seven_day', percentUsed: 73, resetsAt: '2026-10-08T12:00:00Z' }]
  // the heartbeat's snapshot carries the new reading: the account is asked before it is named
  await clock.advance(61_000)
  expect(snapshot().account).toEqual({ id: 'fedcba987654', label: 'other@example.com' })
  expect(snapshot().usage.rateLimits).toEqual([{ kind: 'seven_day', percentUsed: 73, resetsAt: '2026-10-08T12:00:00Z' }])
})

const PANE = {
  plugin: 'agent-board',
  component: 'Pane',
  requestId: 'agent-board',
  props: {
    title: 'Subagents',
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
  description: 'Top-venue paper search',
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
    expect((await ui.find({ type: 'Text', text: /Top-venue paper search/ }))?.text).toBe('● Top-venue paper search')
    expect(await ui.find({ type: 'Text', text: /general-purpose · 0 steps · last: starting/ })).toBeDefined()
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
  expect((await ui.find({ type: 'Text', text: /Top-venue paper search/ }))?.text).toBe('✓ Top-venue paper search')
  expect(await ui.find({ type: 'Text', text: '1:05' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /token 34k \(cache read 30k\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 running · 1 ended/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Top-venue paper search/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No subagents in this session yet/ })).toBeDefined()
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

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'Industry news search' })
  await $.turn.complete({
    answer: '',
    durationMs: 10,
    isAborted: true,
    turnId: 'turn-2',
    agentId: 'agent-2',
    reason: 'aborted',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Industry news search/ }))?.text).toBe('■ Industry news search')
  expect(await ui.find({ type: 'Text', text: /stopped$/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /1 running · 1 ended/ })).toBeDefined()
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

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_3', description: 'Wiki duplicate check' })
  expect(pathKey(written.at(-1)?.path ?? '')).toBe('/home/tester/.claude/agent-board/sessions/session-1.json')
  const started = JSON.parse(written.at(-1)?.text ?? '{}')
  expect(started).toMatchObject({ sessionId: 'session-1', cwd: '/work/project', isClosed: false })
  expect(started.agents[0]).toMatchObject({ label: 'Wiki duplicate check', status: 'running', steps: 0, lastAction: 'starting' })
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
  expect(activity()).toMatchObject({ state: 'waiting', kind: 'question', reason: 'has a question for you' })
  answer?.()
  await asking
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'working' })

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await clock.advance(1_000)
  expect(activity()).toMatchObject({ state: 'waiting', kind: 'permission', reason: 'needs your OK for Bash' })

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
