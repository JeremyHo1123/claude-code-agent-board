// Drives Agent Board's extension logic with a stand-in vscode module and a controlled clock:
// notifications, the merged usage windows, transcript titles, tab focus and the current session.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const toasts = []
const tabs = { activeTabGroup: { activeTab: undefined } }
const fakeVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id
    }
  },
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {} }),
    showInformationMessage: text => (toasts.push(['info', text]), Promise.resolve(undefined)),
    showWarningMessage: text => (toasts.push(['warning', text]), Promise.resolve(undefined)),
    showErrorMessage: text => (toasts.push(['error', text]), Promise.resolve(undefined)),
    tabGroups: {
      get activeTabGroup() {
        return tabs.activeTabGroup
      },
      onDidChangeTabs: () => ({ dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
  },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { executeCommand: () => Promise.resolve() },
}
const realLoad = Module._load
Module._load = function (request, ...rest) {
  return request === 'vscode' ? fakeVscode : realLoad.call(this, request, ...rest)
}

const {
  AgentBoard,
  mergeUsage,
  promptsIn,
  firstPromptIn,
  promptHead,
  promptNeedle,
  entrypointIn,
  titlesIn,
  tabLabelOf,
  isPromptLabel,
  parseAgentTranscript,
  parseWorkflowRun,
  findAgentTranscript,
  DETAIL_LIMITS,
} = require('../extension.js')

let now = 1_000_000_000
Date.now = () => now
const take = () => toasts.splice(0)
const has = (list, kind, prefix) => list.some(([k, text]) => k === kind && text.startsWith(prefix))

async function main() {
  // ── notifications ─────────────────────────────────────────────
  {
    const board = new AgentBoard({ subscriptions: [] })
    const agent = (id, status, extra = {}) => ({ id, label: `agent ${id}`, status, startedAt: now - 60_000, lastAt: now, ...extra })
    // the 5-hour window as an API response reported it, just now
    const session = (activity, agents, percent, resetsAt = '2030-01-01T00:00:00Z') => ({
      sessionId: 's1',
      cwd: 'C:/Users/tester/projects/my-notes',
      updatedAt: now,
      isClosed: false,
      activity,
      usage: { rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt }], rateLimitsAt: now },
      agents,
    })
    const poll = (sessions, shared) => {
      board.usage = mergeUsage(sessions, shared)
      board.notify(sessions)
    }

    // 1. the first poll is only a baseline: running agents, a working turn, 75% used
    poll([session({ state: 'working', since: now - 200_000 }, ['a1', 'a2', 'a3', 'a4'].map(id => agent(id, 'running')), 75)])
    assert.deepEqual(take(), [], 'the baseline poll announces nothing')

    // 2. three finish (one batched toast), one fails, a long turn ends, the 5-hour window crosses 80%
    now += 1_000
    const ended = { endedAt: now }
    poll([
      session(
        { state: 'idle', since: now },
        [agent('a1', 'done', ended), agent('a2', 'done', ended), agent('a3', 'done', ended), agent('a4', 'failed', ended)],
        82,
      ),
    ])
    const second = take()
    assert.equal(second.length, 4, JSON.stringify(second))
    assert.ok(has(second, 'info', '✓ 3 個子代理完成'), JSON.stringify(second))
    assert.ok(has(second, 'error', '✕ 子代理失敗：agent a4'), JSON.stringify(second))
    assert.ok(has(second, 'info', '「my-notes」這一輪做完了'), JSON.stringify(second))
    assert.ok(has(second, 'warning', '5 小時工作階段已用 82%'), JSON.stringify(second))

    // 3. a wait that has lasted 5 s is not news yet; at 20 s it is, once — named by the title when there is one
    now += 60_000
    const waitSince = now - 5_000
    const waiting = () => ({
      ...session({ state: 'waiting', since: waitSince, reason: '等你允許 Bash', kind: 'permission' }, [], 82),
      title: '整理讀書筆記',
    })
    poll([waiting()])
    assert.deepEqual(take(), [], 'a 5 s wait stays quiet')
    now += 15_000
    poll([waiting()])
    assert.deepEqual(take(), [['warning', '「整理讀書筆記」的 Claude 在等你：等你允許 Bash']])
    now += 5_000
    poll([waiting()])
    assert.deepEqual(take(), [], 'the same wait is announced once')

    // 4. 91% crosses the next threshold
    poll([session({ state: 'working', since: now }, [], 91)])
    const fourth = take()
    assert.equal(fourth.length, 1, JSON.stringify(fourth))
    assert.ok(has(fourth, 'error', '5 小時工作階段已用 91%'), JSON.stringify(fourth))

    // 5. a reset (a new resetsAt) drops back silently; crossing 80% again is news again
    poll([session({ state: 'working', since: now }, [], 10, '2030-01-01T05:00:00Z')])
    assert.deepEqual(take(), [], 'a reset is silent')
    poll([session({ state: 'working', since: now }, [], 85, '2030-01-01T05:00:00Z')])
    const fifth = take()
    assert.equal(fifth.length, 1, JSON.stringify(fifth))
    assert.ok(has(fifth, 'warning', '5 小時工作階段已用 85%'), JSON.stringify(fifth))

    // 6. a short turn ending is no news
    now += 1_000
    poll([session({ state: 'idle', since: now }, [], 85, '2030-01-01T05:00:00Z')])
    assert.deepEqual(take(), [], 'a short turn ends quietly')

    // 7. a figure swaying between the two sources around a threshold toasts once
    const sway = (percent, source) => {
      now += 1_000
      const reset = '2030-01-01T10:00:00Z'
      if (source === 'plan') {
        // the shared read is fresher than any response
        poll([{ ...session({ state: 'idle', since: now }, [], 0), usage: undefined }], {
          plan: { fetchedAt: now, windows: [{ key: 'five_hour', label: '5 小時工作階段', percent, resetsAt: reset }] },
        })
      } else {
        poll([session({ state: 'idle', since: now }, [], percent, reset)])
      }
    }
    sway(50, 'response')
    take()
    sway(79.6, 'plan')
    sway(80, 'response')
    sway(79.6, 'plan')
    sway(80, 'response')
    const swayed = take()
    assert.equal(swayed.length, 1, JSON.stringify(swayed))
    assert.ok(has(swayed, 'warning', '5 小時工作階段已用 80%'), JSON.stringify(swayed))

    // 8. a reading without a reset time belongs to the window already known: no silent restart, no repeat
    now += 1_000
    poll([{ ...session({ state: 'idle', since: now }, [], 80), usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 80 }], rateLimitsAt: now } }])
    assert.deepEqual(take(), [], 'a reading without resetsAt repeats nothing')
  }

  // ── merged usage: both sources, the plan's labels and resets, the extra line ──
  {
    const shared = {
      plan: {
        fetchedAt: 100,
        windows: [
          { key: 'five_hour', label: '5 小時工作階段', percent: 50, resetsAt: '2030-01-01T00:00:00.000000+00:00' },
          { key: 'seven_day', label: '每週・所有模型', percent: 20, resetsAt: '2030-01-05T00:00:00Z' },
          { key: 'seven_day_opus', label: '每週・Opus', percent: 10, resetsAt: '2030-01-05T00:00:00Z' },
        ],
        extra: { usedCredits: 120, monthlyLimit: 5000, currency: 'USD', percent: 2.4 },
      },
      nextAttemptAt: 400,
      lastError: { at: 300, status: 429 },
    }
    const fresh = { sessionId: 'a', usage: { rateLimits: [{ kind: 'seven_day', percentUsed: 21 }, { kind: 'five_hour', percentUsed: 55, resetsAt: '2030-01-01T00:00:00Z' }], rateLimitsAt: 200 } }
    const stale = { sessionId: 'b', usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], rateLimitsAt: 50 } }
    const unknownAge = { sessionId: 'c', usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 99 }] } }
    const merged = mergeUsage([stale, unknownAge, fresh], shared)

    assert.deepEqual(
      merged.list.map(window => [window.key, window.percent, window.source, window.at]),
      [
        ['five_hour', 55, 'response', 200],
        ['seven_day', 21, 'response', 200],
        ['seven_day_opus', 10, 'plan', 100],
      ],
    )
    // the plan's label and reset carry over to a response reading that lacks them
    assert.equal(merged.list[1].label, '每週・所有模型')
    assert.equal(merged.list[1].resetsAt, '2030-01-05T00:00:00.000Z')
    assert.equal(merged.list[0].resetsAt, '2030-01-01T00:00:00.000Z')
    assert.equal(merged.extra.usedCredits, 120)
    assert.equal(merged.planAt, 100)
    assert.deepEqual(merged.planError, { at: 300, status: 429 })
    assert.equal(merged.planNextAt, 400)

    // with no shared read yet, the responses alone; a known kind gets its Chinese label
    const alone = mergeUsage([fresh], undefined)
    assert.deepEqual(alone.list.map(window => [window.key, window.label]), [
      ['five_hour', '5 小時工作階段'],
      ['seven_day', '每週・所有模型'],
    ])
    assert.equal(alone.planError, undefined)

    // a session still on the previous mod carries its own read: fresher than the shared one, it wins
    const legacy = {
      sessionId: 'old',
      usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 30 }] },
      plan: {
        fetchedAt: 250,
        windows: [{ key: 'seven_day_opus', label: '每週・Opus', percent: 12, resetsAt: '2030-01-05T00:00:00Z' }],
        extra: { usedCredits: 130, monthlyLimit: 5000, currency: 'USD', percent: 2.6 },
      },
    }
    const transition = mergeUsage([fresh, legacy], shared)
    assert.deepEqual(
      transition.list.map(window => [window.key, window.percent, window.source, window.at]),
      [
        ['five_hour', 55, 'response', 200],
        ['seven_day', 21, 'response', 200],
        ['seven_day_opus', 12, 'plan', 250],
      ],
    )
    assert.equal(transition.extra.usedCredits, 130, 'the extra line follows the freshest read')
    assert.equal(transition.planAt, 250)
  }

  // ── which reading of a window is the truth ────────────────────
  {
    const R1 = '2030-01-01T00:00:00.000Z'
    const R2 = '2030-01-01T05:00:00.000Z'
    // a session whose last reply carried this 5-hour reading, and claude.ai's own answer
    const reply = (percent, at, resetsAt = R1) => ({
      sessionId: `s${at}`,
      usage: { rateLimits: [{ kind: 'five_hour', percentUsed: percent, ...(resetsAt ? { resetsAt } : {}) }], rateLimitsAt: at },
    })
    const asked = (percent, at, resetsAt = R1) => ({
      plan: { fetchedAt: at, windows: [{ key: 'five_hour', label: '5 小時工作階段', percent, ...(resetsAt ? { resetsAt } : {}) }] },
    })
    const settle = (sessions, shared) => {
      const [window] = mergeUsage(sessions, shared).list

      return [window.percent, window.source, window.at, window.resetsAt]
    }

    // replies run behind (each is as of before its own request was counted): the highest reading stands
    assert.deepEqual(settle([reply(7, 110_000), reply(10, 105_000)], asked(11, 100_000)), [11, 'plan', 100_000, R1])
    // a later reply that reaches further raises it; one that only agrees makes it fresher
    assert.deepEqual(settle([reply(7, 110_000), reply(12, 130_000)], asked(11, 100_000)), [12, 'response', 130_000, R1])
    assert.deepEqual(settle([reply(11, 120_000)], asked(11, 100_000)), [11, 'response', 120_000, R1])
    // claude.ai's answer stands for all before it: an earlier reply, even a higher one (another account's), is left out
    assert.deepEqual(settle([reply(68, 90_000)], asked(11, 100_000)), [11, 'plan', 100_000, R1])
    assert.deepEqual(settle([reply(95, 90_000, R1)], asked(2, 100_000, R2)), [2, 'plan', 100_000, R2])
    // a new window (a reset, a change of account) that a later reply names first: the earlier window falls away
    assert.deepEqual(settle([reply(1, 130_000, R2)], asked(95, 100_000, R1)), [1, 'response', 130_000, R2])
    // claude.ai naming no window says there is none; a later reply that names one starts it
    assert.deepEqual(settle([reply(60, 90_000, R1)], asked(0, 100_000, null)), [0, 'plan', 100_000, undefined])
    assert.deepEqual(settle([reply(0, 130_000, R2)], asked(0, 100_000, null)), [0, 'response', 130_000, R2])
    // with no claude.ai read at all: the replies of the latest window, none older than ten minutes before the newest
    assert.deepEqual(
      settle([reply(9, 1_000_000), reply(10, 990_000), reply(80, 300_000)], undefined),
      [10, 'response', 990_000, R1],
    )
    assert.deepEqual(settle([reply(3, 1_000_000, R2), reply(90, 990_000, R1)], undefined), [3, 'response', 1_000_000, R2])
  }

  // ── two accounts on one machine: each settled on its own ──────
  {
    const FIVE = '2030-01-01T00:00:00.000Z' // both 5-hour windows reset together, as two sign-ins primed at once do
    const WEEK_A = '2030-01-03T12:00:00.000Z'
    const WEEK_B = '2030-01-04T06:00:00.000Z'
    const A = { id: 'aaaa1111', label: 'a@example.com' }
    const B = { id: 'bbbb2222', label: 'b@example.com' }
    const at = now - 60_000
    const session = (sessionId, account, five, week, weekReset, readAt = at) => ({
      sessionId,
      cwd: `/home/tester/${sessionId}`,
      updatedAt: now,
      isClosed: false,
      ...(account ? { account } : {}),
      usage: {
        rateLimits: [
          { kind: 'five_hour', percentUsed: five, resetsAt: FIVE },
          { kind: 'seven_day', percentUsed: week, resetsAt: weekReset },
        ],
        rateLimitsAt: readAt,
      },
      agents: [],
    })
    const read = (account, five, week, weekReset, fetchedAt, extra = {}) => ({
      ...(account ? { account } : {}),
      plan: {
        fetchedAt,
        windows: [
          { key: 'five_hour', label: '5 小時工作階段', percent: five, resetsAt: FIVE },
          { key: 'seven_day', label: '每週・所有模型', percent: week, resetsAt: weekReset },
        ],
      },
      nextAttemptAt: fetchedAt + 30_000,
      lastAttemptAt: fetchedAt,
      ...extra,
    })
    const figures = account => account.list.map(window => [window.key, window.percent, window.resetsAt])

    // account B's reply is the newest and its 5-hour figure the highest: neither reaches account A's windows
    const merged = mergeUsage(
      [session('vscode', A, 1, 37, WEEK_A), session('desktop', B, 9, 34, WEEK_B, now - 5_000)],
      [read(A, 2, 37, WEEK_A, now - 90_000), read(B, 4, 33, WEEK_B, now - 90_000, { lastError: { at: now - 20_000, status: 429 } })],
      'vscode',
    )
    assert.deepEqual(merged.accounts.map(account => [account.id, account.label, account.isCurrent, account.sessions]), [
      ['aaaa1111', 'a@example.com', true, ['vscode']],
      ['bbbb2222', 'b@example.com', false, ['desktop']],
    ])
    assert.deepEqual(figures(merged.accounts[0]), [['five_hour', 2, FIVE], ['seven_day', 37, WEEK_A]])
    assert.deepEqual(figures(merged.accounts[1]), [['five_hour', 9, FIVE], ['seven_day', 34, WEEK_B]])
    // each account's shared read fails or works on its own
    assert.equal(merged.accounts[0].planError, undefined)
    assert.deepEqual(merged.accounts[1].planError, { at: now - 20_000, status: 429 })
    // the top level is the account of the conversation in view
    assert.deepEqual(figures(merged), figures(merged.accounts[0]))
    assert.deepEqual(figures(mergeUsage([session('vscode', A, 1, 37, WEEK_A), session('desktop', B, 9, 34, WEEK_B)], [], 'desktop')), [
      ['five_hour', 9, FIVE],
      ['seven_day', 34, WEEK_B],
    ])

    // a session that has not learnt its account yet joins the one whose weekly window it shares
    const joining = mergeUsage(
      [session('vscode', A, 1, 37, WEEK_A), session('desktop', B, 9, 34, WEEK_B), session('reloading', undefined, 6, 38, WEEK_A, now - 1_000)],
      [],
      'vscode',
    )
    assert.deepEqual(joining.accounts.map(account => [account.id, account.sessions.length]), [['aaaa1111', 2], ['bbbb2222', 1]])
    assert.deepEqual(figures(joining.accounts[0]), [['five_hour', 6, FIVE], ['seven_day', 38, WEEK_A]])

    // a previous mod's shared read: joined while fresh, left out once stale beside a named one; never an account of its own
    const fresh = mergeUsage([session('vscode', A, 1, 37, WEEK_A)], [read(A, 2, 37, WEEK_A, now - 90_000), read(undefined, 3, 39, WEEK_A, now - 30_000)], 'vscode')
    assert.deepEqual(figures(fresh.accounts[0]), [['five_hour', 3, FIVE], ['seven_day', 39, WEEK_A]])
    const stale = mergeUsage(
      [session('vscode', A, 1, 37, WEEK_A)],
      [read(A, 2, 37, WEEK_A, now - 90_000), read(undefined, 50, 60, WEEK_B, now - 3_600_000)],
      'vscode',
    )
    assert.deepEqual(stale.accounts.map(account => account.id), ['aaaa1111'])
    assert.deepEqual(figures(stale.accounts[0]), [['five_hour', 2, FIVE], ['seven_day', 37, WEEK_A]])

    // an account whose sessions are all gone leaves its read behind: not shown beside one in use
    const gone = mergeUsage([session('vscode', A, 1, 37, WEEK_A)], [read(A, 2, 37, WEEK_A, now - 90_000), read(B, 4, 33, WEEK_B, now - 90_000)], 'vscode')
    assert.deepEqual(gone.accounts.map(account => account.id), ['aaaa1111'])

    // with no account known anywhere, one unnamed account: the single settling it always was
    const unknown = mergeUsage([session('one', undefined, 1, 37, WEEK_A), session('two', undefined, 9, 34, WEEK_B, now - 5_000)], [], 'one')
    assert.deepEqual(unknown.accounts.map(account => account.id), [''])

    // an account only the desktop app is signed in to is left out, named or not, unless asked for
    const inVscode = { ...session('vscode', A, 1, 37, WEEK_A), entrypoint: 'claude-vscode' }
    const inDesktop = account => ({ ...session('desktop', account, 9, 34, WEEK_B, now - 5_000), entrypoint: 'claude-desktop' })
    const reads = [read(A, 2, 37, WEEK_A, now - 90_000), read(B, 4, 33, WEEK_B, now - 90_000)]
    for (const account of [B, undefined]) {
      const quiet = mergeUsage([inVscode, inDesktop(account)], reads, 'desktop')
      assert.deepEqual(quiet.accounts.map(one => one.id), ['aaaa1111'])
      assert.deepEqual(figures(quiet), [['five_hour', 2, FIVE], ['seven_day', 37, WEEK_A]])
    }
    assert.deepEqual(mergeUsage([inVscode, inDesktop(B)], reads, 'vscode', true).accounts.map(one => one.id), ['aaaa1111', 'bbbb2222'])
    // the desktop app signed in to VS Code's own account spends from the same windows: its readings count
    assert.deepEqual(figures(mergeUsage([inVscode, { ...inDesktop(A), usage: session('x', A, 9, 40, WEEK_A, now - 5_000).usage }], reads, 'vscode')), [
      ['five_hour', 9, FIVE],
      ['seven_day', 40, WEEK_A],
    ])
    // a dead session beside the desktop app's, with no reading and no transcript found, does not keep the account in view
    const dead = { sessionId: 'dead', cwd: '/home/tester/dead', updatedAt: now - 3_600_000, isClosed: false, agents: [] }
    assert.deepEqual(mergeUsage([inVscode, inDesktop(undefined), dead], [read(A, 2, 37, WEEK_A, now - 90_000)], 'vscode').accounts.map(one => one.id), [
      'aaaa1111',
    ])
    // with only the desktop app's conversations open there is no usage to show
    assert.deepEqual(mergeUsage([inDesktop(B)], reads, 'desktop').accounts, [])

    // a threshold crossed on the other account says whose window it is
    const board = new AgentBoard({ subscriptions: [] })
    const poll = five => {
      board.usage = mergeUsage([session('vscode', A, 1, 37, WEEK_A), session('desktop', B, five, 34, WEEK_B)], [], 'vscode')
      board.notify([])
    }
    poll(50)
    poll(85)
    const crossed = take()
    assert.equal(crossed.length, 1, JSON.stringify(crossed))
    assert.ok(has(crossed, 'warning', '【b@example.com】5 小時工作階段已用 85%'), JSON.stringify(crossed))
  }

  // ── the prompts the person typed, out of transcript rows ──────
  {
    const row = fields => JSON.stringify({ type: 'user', timestamp: '2030-01-01T00:00:10.000Z', ...fields })
    const human = { kind: 'human' }
    const rows = [
      row({ origin: human, message: { role: 'user', content: '把週報腳本改寫成 TypeScript\n先不要動測試' } }),
      // what the engine put beside the prompt is not the prompt
      row({ origin: human, message: { content: [{ type: 'text', text: '<system-reminder>注意</system-reminder>' }, { type: 'text', text: '為什麼這裡會回傳 undefined' }] } }),
      row({ origin: human, message: { content: [{ type: 'image', source: {} }, { type: 'text', text: '長這樣' }] } }),
      // a slash command, a tool's result, a skill's text, a subagent's prompt, a queued notification: none typed
      row({ origin: human, message: { content: '<command-name>/jump</command-name>' } }),
      row({ message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      row({ isMeta: true, origin: human, message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } }),
      row({ isSidechain: true, origin: human, message: { content: '搜尋本週論文' } }),
      row({ origin: { kind: 'task-notification' }, message: { content: '子代理完成了' } }),
      '{"type":"user","origin":{"kind":"human"},"message":{"content":"寫到一半', // caught mid-write
    ]
    const prompts = promptsIn(rows.join('\n'))
    assert.deepEqual(prompts.map(prompt => prompt.text), ['把週報腳本改寫成 TypeScript\n先不要動測試', '為什麼這裡會回傳 undefined', '長這樣'])
    assert.equal(prompts[0].at, Date.parse('2030-01-01T00:00:10.000Z'))

    // pasted text is the person's: its tags go, the text stays
    const pasted = row({
      origin: human,
      message: {
        content: [
          { type: 'text', text: '<browser_instruction>…</browser_instruction>' },
          { type: 'text', text: '\n\n<pasted_content id="1234">\n接著寫第 3 到 5 章\n\n先讀這幾個檔案\n</pasted_content id="1234">\n' },
        ],
      },
    })
    assert.deepEqual(promptsIn(pasted).map(prompt => prompt.text), ['接著寫第 3 到 5 章\n\n先讀這幾個檔案'])

    // the first prompt, which labels the tab of a conversation Claude Code has not titled: typed, else a slash command
    assert.equal(firstPromptIn(rows.join('\n')), '把週報腳本改寫成 TypeScript\n先不要動測試')
    assert.equal(firstPromptIn([rows[4], rows[3], rows[0]].join('\n')), '/jump')
    assert.equal(firstPromptIn(pasted), '接著寫第 3 到 5 章\n\n先讀這幾個檔案')
    const command = '<command-message>summarize</command-message>\n<command-name>/summarize</command-name>\n<command-args>整理讀書筆記</command-args>'
    assert.equal(firstPromptIn(row({ origin: human, message: { content: command } })), '/summarize 整理讀書筆記')
    assert.equal(firstPromptIn(rows.slice(4).join('\n')), undefined, 'nothing typed yet')

    // a prompt typed in the desktop app is stamped the same way: a conversation begun there lists whole
    assert.equal(promptsIn(row({ entrypoint: 'claude-desktop', origin: human, message: { content: '在桌面版問的' } })).length, 1)
    // the program is the one that wrote last: begun in the desktop app, carried on in VS Code, it is VS Code's
    const begun = row({ entrypoint: 'claude-desktop', origin: human, message: { content: '在桌面版問的' } })
    const resumed = row({ entrypoint: 'claude-vscode', origin: human, message: { content: '在 VS Code 接著問' } })
    assert.equal(entrypointIn(Buffer.from(`${begun}\n${resumed}\n`)), 'claude-vscode')
    assert.equal(entrypointIn(Buffer.from(`${begun}\n`)), 'claude-desktop')
    assert.equal(entrypointIn(Buffer.from(`${begun}\n{"type":"user","entrypoint":"claude-vs`)), undefined)
    assert.equal(entrypointIn(Buffer.from('{"type":"user"}')), undefined)

    // listed by its first line, cut to fit; searched for by the start of that line
    assert.equal(promptHead('\n  把週報腳本改寫成 TypeScript\n先不要動測試', 80), '把週報腳本改寫成 TypeScript')
    assert.equal(promptHead('一二三四五六', 4), '一二三…')
    assert.equal(promptNeedle('  為什麼這裡會回傳 undefined  \n第二行'), '為什麼這裡會回傳 undefined')
    assert.equal(Array.from(promptNeedle('好'.repeat(50))).length, 32)

    // the board reads a transcript as it grows: whole rows only, the rest with what comes after
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prompts-'))
    const file = path.join(dir, 's1.jsonl')
    const board = new AgentBoard({ subscriptions: [] })
    board.titles.set('s1', { path: file })
    fs.writeFileSync(file, `${rows[0]}\n${rows[1].slice(0, 40)}`)
    await board.refreshPrompts('s1')
    assert.deepEqual(board.promptsOf('s1').list.map(prompt => prompt.head), ['把週報腳本改寫成 TypeScript'])
    fs.appendFileSync(file, `${rows[1].slice(40)}\n`)
    now += 5_000
    await board.refreshPrompts('s1')
    assert.deepEqual(board.promptsOf('s1'), {
      sessionId: 's1',
      list: [
        { at: Date.parse('2030-01-01T00:00:10.000Z'), head: '把週報腳本改寫成 TypeScript' },
        { at: Date.parse('2030-01-01T00:00:10.000Z'), head: '為什麼這裡會回傳 undefined' },
      ],
    })
    assert.equal(board.promptsOf('other'), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── tab labels and transcript titles ──────────────────────────
  {
    assert.equal(tabLabelOf('整理讀書筆記'), '整理讀書筆記')
    const exactly25 = 'a'.repeat(25)
    assert.equal(tabLabelOf(exactly25), exactly25)
    assert.equal(tabLabelOf('Compare add and concat for skip connections in PyTorch'), 'Compare add and concat f…')

    // an untitled conversation's tab carries its first prompt, cut the same way: as typed, or as listed after a reload
    const typed = '/summarize 整理 2030-01-01 的讀書筆記\n\n要改的地方'
    assert.equal(isPromptLabel(tabLabelOf(typed), typed), true)
    assert.equal(isPromptLabel(tabLabelOf(typed.replace(/\s+/g, ' ')), typed), true)
    assert.equal(isPromptLabel(tabLabelOf('第 6 段\n\n先讀這幾個檔案，讀完再動手做下一步'), '第 6 段 先讀這幾個檔案，讀完再動手做下一步'), true)
    assert.equal(isPromptLabel('/jump', '/jump'), true)
    assert.equal(isPromptLabel('/jump', '/jump 到第二段'), false, 'a label not cut is the whole prompt')
    assert.equal(isPromptLabel(tabLabelOf(typed), '/summarize 整理 2030-02-01 的讀書筆記'), false)
    assert.equal(isPromptLabel('Claude Code', '整理讀書筆記'), false)
    assert.equal(isPromptLabel('…', '整理讀書筆記'), false)

    const rows = [
      '{"type":"user","message":"hi"}',
      '{"type":"ai-title","sessionId":"x","aiTitle":"舊標題"}',
      '{"type":"assistant","message":"…"}',
      '{"type":"ai-title","aiTitle":"新標題","sessionId":"x"}',
      '{"type":"ai-title","aiTitle":"寫到一半', // caught mid-write
    ]
    assert.deepEqual(titlesIn(Buffer.from(rows.join('\n'))), { ai: '新標題' })
    assert.deepEqual(
      titlesIn(Buffer.from([...rows.slice(0, 4), '{"type":"custom-title","customTitle":"我改的名字","sessionId":"x"}'].join('\n'))),
      { custom: '我改的名字', ai: '新標題' },
    )
    // a stretch that starts mid-row: the cut row is skipped, not misread
    assert.deepEqual(titlesIn(Buffer.from('e":"ai-title","aiTitle":"殘片"}\n{"type":"user"}')), {})
  }

  // ── reading titles from a transcript: the tail, the whole file once, then only what was appended ──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-'))
    const file = path.join(dir, 'x.jsonl')
    // the title sits at the start, then more than the tail's megabyte of other rows
    const filler = `${'{"type":"assistant","message":"' + 'x'.repeat(1000) + '"}\n'}`.repeat(1200)
    fs.writeFileSync(file, `{"type":"ai-title","aiTitle":"開頭的標題","sessionId":"x"}\n${filler}`)

    const board = new AgentBoard({ subscriptions: [] })
    board.titles.set('x', { path: file, size: 0, custom: undefined, ai: undefined, isScanned: false, checkedAt: 0, soughtAt: 0 })
    const live = [{ sessionId: 'x', isClosed: false }]
    await board.refreshTitles(live)
    assert.equal(board.titleOf('x'), '開頭的標題', 'the whole-file scan finds a title the tail lacks')

    // a rename is appended: found once the recheck interval passes, reading only the new bytes
    fs.appendFileSync(file, '{"type":"custom-title","customTitle":"改名後","sessionId":"x"}\n')
    now += 30_000
    await board.refreshTitles(live)
    assert.equal(board.titleOf('x'), '開頭的標題', 'a titled transcript waits for the recheck interval')
    now += 31_000
    await board.refreshTitles(live)
    assert.equal(board.titleOf('x'), '改名後', 'the appended custom title wins')

    // no title: the first prompt is read from the head, past more than the tail's megabyte; a title, once written, wins
    const untitled = path.join(dir, 'u.jsonl')
    const typed = '{"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"接著寫第 3 到 5 章\\n先讀這幾個檔案"}}\n'
    fs.writeFileSync(untitled, `{"type":"queue-operation"}\n${typed}${filler}`)
    board.titles.set('u', { path: untitled, size: 0, custom: undefined, ai: undefined, first: undefined, isScanned: false, checkedAt: 0, soughtAt: 0 })
    await board.refreshTitles([{ sessionId: 'u', isClosed: false }])
    assert.equal(board.titleOf('u'), undefined)
    assert.equal(board.firstPromptOf('u'), '接著寫第 3 到 5 章\n先讀這幾個檔案')
    assert.equal(board.displayNameOf('u'), '接著寫第 3 到 5 章')
    fs.appendFileSync(untitled, '{"type":"ai-title","aiTitle":"讀書筆記第 3 到 5 章","sessionId":"u"}\n')
    now += 21_000
    await board.refreshTitles([{ sessionId: 'u', isClosed: false }])
    assert.equal(board.firstPromptOf('u'), undefined)
    assert.equal(board.displayNameOf('u'), '讀書筆記第 3 到 5 章')

    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── focus: the context meter follows the focused Claude tab, else stays put ──
  {
    const board = new AgentBoard({ subscriptions: [] })
    const claudeTab = label => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })
    const make = (sessionId, since) => ({
      sessionId,
      cwd: 'C:/v',
      updatedAt: now,
      isClosed: false,
      activity: { state: 'working', since },
      agents: [],
    })
    const titled = (sessionId, title) =>
      board.titles.set(sessionId, { path: 'p', size: 1, custom: undefined, ai: title, isScanned: true, checkedAt: now, soughtAt: now })

    let sessions = [make('a', now - 3_000), make('b', now - 2_000), make('c', now - 1_000)]
    titled('a', '整理讀書筆記')
    titled('b', 'Compare add and concat for skip connections in PyTorch')

    // nothing focused yet: the session that acted last, and it stays while others act after it
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'c', isFocused: false })
    sessions = [make('a', now), make('b', now - 2_000), make('c', now - 1_000)]
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'c', isFocused: false }, 'no hopping to the latest actor')

    // a long title's tab carries the cut label
    tabs.activeTabGroup = { activeTab: claudeTab('Compare add and concat f…') }
    assert.equal(board.updateFocus(sessions), true)
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'b', isFocused: true })
    assert.equal(board.updateFocus(sessions), false, 'the same tab again changes nothing')

    // a file editor takes focus: the last Claude tab stays the current one
    tabs.activeTabGroup = { activeTab: { label: 'CLAUDE.md', input: { uri: 'file:///CLAUDE.md' } } }
    assert.equal(board.updateFocus(sessions), false)
    assert.equal(board.currentSessionId(sessions).sessionId, 'b')

    // a new conversation's tab ("Claude Code") is the one live session without a title
    tabs.activeTabGroup = { activeTab: claudeTab('Claude Code') }
    assert.equal(board.updateFocus(sessions), true)
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'c', isFocused: true })

    // two untitled sessions: an unmatched tab cannot tell them apart, so the focus stays
    now += 1_000
    sessions = [...sessions, make('d', now)]
    tabs.activeTabGroup = { activeTab: claudeTab('Claude Code') }
    assert.equal(board.updateFocus(sessions), false)
    assert.equal(board.currentSessionId(sessions).sessionId, 'c')

    // the focused session closes: back to the settled pick, which is re-chosen only when it is gone
    sessions = sessions.map(session => (session.sessionId === 'c' ? { ...session, isClosed: true } : session))
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'd', isFocused: false })

    // a conversation in the desktop app is never the current one, however lately it acted: it has no tab here
    now += 1_000
    const desktop = { ...make('e', now), entrypoint: 'claude-desktop' }
    sessions = sessions.map(session => (session.sessionId === 'd' ? { ...session, isClosed: true } : session))
    assert.notEqual(board.currentSessionId([...sessions, desktop]).sessionId, 'e')
    assert.deepEqual(new AgentBoard({ subscriptions: [] }).currentSessionId([desktop]), { sessionId: undefined, isFocused: false })

    // opened in a Claude tab here, it is the current one: the tab shows it, whatever its transcript says so far
    const opened = new AgentBoard({ subscriptions: [] })
    opened.titles.set('e', { path: 'x', size: 1, ai: '在桌面版開始的對話', checkedAt: now, entrypoint: 'claude-desktop' })
    tabs.activeTabGroup = { activeTab: claudeTab('在桌面版開始的對話') }
    assert.equal(opened.updateFocus([desktop]), true)
    assert.deepEqual(opened.currentSessionId([desktop]), { sessionId: 'e', isFocused: true })
  }

  // ── focus on conversations Claude Code has not titled: their tabs carry the first prompt ──
  {
    const board = new AgentBoard({ subscriptions: [] })
    const claudeTab = label => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } })
    const make = sessionId => ({ sessionId, cwd: 'C:/v', updatedAt: now, isClosed: false, activity: { state: 'working', since: now }, agents: [] })
    const read = (sessionId, fields) =>
      board.titles.set(sessionId, { path: 'p', size: 1, custom: undefined, ai: undefined, first: undefined, isScanned: true, checkedAt: now, soughtAt: now, ...fields })
    const summarize = '/summarize 整理 2030-01-01 的讀書筆記\n\n要改的地方'
    const next = '接著寫第 3 到 5 章（筆記在 notes/book/）。\n先讀這幾個檔案'
    const sessions = [make('p'), make('q'), make('r')]
    read('p', { first: summarize })
    read('q', { first: next })
    read('r', { first: next })

    // three untitled sessions: the prompt on the tab tells which
    tabs.activeTabGroup = { activeTab: claudeTab(tabLabelOf(summarize)) }
    assert.equal(board.updateFocus(sessions), true)
    assert.deepEqual(board.currentSessionId(sessions), { sessionId: 'p', isFocused: true })
    assert.equal(board.displayNameOf('p'), '/summarize 整理 2030-01-01 的讀書筆記')

    // two begun alike cannot be told apart: the focus stays
    tabs.activeTabGroup = { activeTab: claudeTab(tabLabelOf(next)) }
    assert.equal(board.updateFocus(sessions), false)
    assert.equal(board.currentSessionId(sessions).sessionId, 'p')

    // titled, one's tab carries the title, and the prompt's label names only the other
    read('q', { ai: '讀書筆記第 3 到 5 章', first: next })
    tabs.activeTabGroup = { activeTab: claudeTab('讀書筆記第 3 到 5 章') }
    assert.equal(board.updateFocus(sessions), true)
    assert.equal(board.currentSessionId(sessions).sessionId, 'q')
    tabs.activeTabGroup = { activeTab: claudeTab(tabLabelOf(next)) }
    assert.equal(board.updateFocus(sessions), true)
    assert.equal(board.currentSessionId(sessions).sessionId, 'r')
  }

  // ── the status bar's context item: the current conversation's, the others in its tooltip ──
  {
    const board = new AgentBoard({ subscriptions: [] })
    const withContext = (sessionId, title, percent) => ({
      sessionId,
      title,
      cwd: 'C:/v',
      updatedAt: now,
      isClosed: false,
      agents: [],
      usage: { contextPercent: percent, contextTokens: percent * 10_000, contextWindow: 1_000_000, isContextEstimate: true },
    })
    const sessions = [withContext('a', '整理讀書筆記', 34), withContext('b', '比較兩款開發板', 78)]
    let isShown = false
    board.contextItem.show = () => {
      isShown = true
    }
    board.contextItem.hide = () => {
      isShown = false
    }

    board.updateContextItem(sessions, { sessionId: 'b', isFocused: true })
    assert.equal(isShown, true)
    assert.equal(board.contextItem.text, '$(pie-chart) 上下文 78%')
    assert.equal(board.contextItem.backgroundColor.id, 'statusBarItem.warningBackground')
    assert.ok(board.contextItem.tooltip.includes('比較兩款開發板：78%（780k / 1M）'), board.contextItem.tooltip)
    assert.ok(board.contextItem.tooltip.includes('・整理讀書筆記：34%（340k / 1M）'), board.contextItem.tooltip)

    // the other conversation takes the focus: the item follows, and is calm again under 70%
    board.updateContextItem(sessions, { sessionId: 'a', isFocused: true })
    assert.equal(board.contextItem.text, '$(pie-chart) 上下文 34%')
    assert.equal(board.contextItem.backgroundColor, undefined)

    // a session with no measurement yet: nothing to show
    board.updateContextItem([{ sessionId: 'c', cwd: 'C:/v', updatedAt: now, isClosed: false, agents: [] }], {
      sessionId: 'c',
      isFocused: false,
    })
    assert.equal(isShown, false)
  }

  // ── an agent's transcript, parsed for its detail ──────────────
  // rows shaped as Claude Code writes them: one row per content block of a reply, each with the
  // reply's usage as it stood; a tool's result in a later user row
  const at = seconds => new Date(Date.UTC(2026, 9, 6, 1, 0, seconds)).toISOString()
  const transcriptRows = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: '找出 wiki 裡提到 flow matching 的頁面' } },
    { type: 'attachment', timestamp: at(0), attachment: { type: 'hook_success' } },
    { type: 'user', isMeta: true, timestamp: at(0), message: { role: 'user', content: '<system-reminder>…</system-reminder>' } },
    {
      type: 'assistant',
      timestamp: at(2),
      requestId: 'r1',
      thinkingDurationMs: 1_200,
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 's' }], usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 } },
    },
    {
      type: 'assistant',
      timestamp: at(3),
      requestId: 'r1',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '先讀概念頁。' }], usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 } },
    },
    {
      type: 'assistant',
      timestamp: at(4),
      requestId: 'r1',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\Users\\tester\\vault\\wiki\\concepts\\flow-matching.md' } }],
        usage: { input_tokens: 2, output_tokens: 40, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
      },
    },
    { type: 'user', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 ---\n2 title: Flow matching' }] } },
    {
      type: 'assistant',
      timestamp: at(7),
      requestId: 'r2',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'grep -rl "flow matching" wiki', description: 'List pages naming it' } }],
        usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 902 },
      },
    },
    { type: 'user', timestamp: at(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: '已攔截裸 grep' }] }] } },
    {
      type: 'assistant',
      timestamp: at(11),
      requestId: 'r3',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'flow matching', path: 'C:\\Users\\tester\\vault\\wiki' } }],
        usage: { input_tokens: 1, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 950 },
      },
    },
  ]
  const asText = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  {
    // mid-run: the third step has no result yet
    const live = parseAgentTranscript(asText(transcriptRows), DETAIL_LIMITS.sidebar)
    assert.equal(live.prompt, '找出 wiki 裡提到 flow matching 的頁面', 'the first user row that is not a reminder')
    assert.equal(live.model, 'claude-opus-5-5')
    assert.equal(live.toolCount, 3)
    assert.equal(live.errorCount, 1)
    assert.deepEqual(
      live.events.map(event => (event.kind === 'tool' ? `${event.name}:${event.endAt === undefined ? 'open' : event.isError ? 'error' : 'ok'}` : `say:${event.text}`)),
      ['say:先讀概念頁。', 'Read:ok', 'Bash:error', 'Grep:open'],
    )
    const [, read, bash, grep] = live.events
    assert.equal(read.summary, '…/wiki/concepts/flow-matching.md')
    assert.equal(read.endAt - read.at, 1_000)
    assert.equal(read.result, '1 ---\n2 title: Flow matching')
    assert.equal(bash.summary, 'List pages naming it', 'a command step shows its description')
    assert.equal(bash.input, 'grep -rl "flow matching" wiki', 'and its command as the input')
    assert.equal(bash.result, '已攔截裸 grep')
    assert.equal(grep.summary, 'flow matching · …/tester/vault/wiki')
    // usage counted once per request, at its largest: r1's 40 output tokens, not 5 + 5 + 40
    assert.deepEqual(live.usage, { input: 6, output: 61, cacheRead: 1_852, cacheWrite: 900 })
    assert.equal(live.thinkingMs, 1_200)
    assert.equal(live.output, undefined)
    assert.equal(live.finalText, undefined, 'a step came after its last words')
    assert.equal(live.startedAt, Date.parse(at(0)))
    assert.equal(live.lastAt, Date.parse(at(11)))

    // ended with a report handed back
    const handback = parseAgentTranscript(
      asText([
        ...transcriptRows,
        { type: 'user', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'wiki/a.md' }] } },
        {
          type: 'assistant',
          timestamp: at(14),
          requestId: 'r4',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'SubagentHandback', input: { message: '## 結果\n- `wiki/a.md`' } }], usage: { output_tokens: 30 } },
        },
      ]),
      DETAIL_LIMITS.sidebar,
    )
    assert.deepEqual(handback.output, { via: 'handback', text: '## 結果\n- `wiki/a.md`', total: 19 })
    assert.equal(handback.toolCount, 3, 'the handback is the report, not a step')

    // a workflow agent's structured result
    const structured = parseAgentTranscript(
      asText([
        transcriptRows[0],
        { type: 'assistant', timestamp: at(3), requestId: 'r9', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'StructuredOutput', input: { ideas: [1, 2] } }] } },
      ]),
      DETAIL_LIMITS.sidebar,
    )
    assert.equal(structured.output.via, 'structured')
    assert.deepEqual(JSON.parse(structured.output.text), { ideas: [1, 2] })

    // ended with words: the last thing it said is the answer
    const worded = parseAgentTranscript(
      asText([transcriptRows[0], { type: 'assistant', timestamp: at(3), requestId: 'r5', message: { role: 'assistant', content: [{ type: 'text', text: '找到 2 頁。' }] } }]),
      DETAIL_LIMITS.sidebar,
    )
    assert.deepEqual(worded.finalText, { text: '找到 2 頁。', total: '找到 2 頁。'.length })

    // stopped by the limit: the synthetic error row is the failure
    const limited = parseAgentTranscript(
      asText([
        transcriptRows[0],
        {
          type: 'assistant',
          timestamp: at(1),
          isApiErrorMessage: true,
          message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] },
        },
      ]),
      DETAIL_LIMITS.sidebar,
    )
    assert.equal(limited.failure, "You've hit your session limit")
    assert.equal(limited.model, undefined, 'a synthetic row names no model')

    // a cut row (a partial read, a row caught mid-write) is passed over; long text is clipped with its length kept
    const big = 'x'.repeat(DETAIL_LIMITS.sidebar.result + 50)
    const clipped = parseAgentTranscript(
      `{"type":"user","mess\n${asText([
        transcriptRows[0],
        transcriptRows[5],
        { type: 'user', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } },
      ])}`,
      DETAIL_LIMITS.sidebar,
    )
    assert.equal(clipped.events[0].resultTotal, big.length)
    assert.equal(clipped.events[0].result.length, DETAIL_LIMITS.sidebar.result + 1)
  }

  // ── a workflow run file, and where an agent's transcript lives ──
  {
    const run = parseWorkflowRun({
      runId: 'wf_1',
      workflowName: 'paper-survey',
      status: 'completed',
      phases: [{ title: '調查', detail: '…' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: '調查' },
        { type: 'workflow_agent', label: 'collect-sources', phaseTitle: '調查', agentId: 'a06', model: 'claude-opus-5', state: 'error', startedAt: 5 },
      ],
    })
    assert.equal(run.name, 'paper-survey')
    assert.deepEqual(run.agents, [{ agentId: 'a06', label: 'collect-sources', phase: '調查', state: 'error', model: 'claude-opus-5', startedAt: 5 }])
    assert.equal(parseWorkflowRun({ nope: true }), undefined)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-'))
    const session = path.join(dir, 's1.jsonl')
    fs.writeFileSync(session, '')
    fs.mkdirSync(path.join(dir, 's1', 'subagents', 'workflows', 'wf_1'), { recursive: true })
    fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-plain.jsonl'), '')
    fs.writeFileSync(path.join(dir, 's1', 'subagents', 'workflows', 'wf_1', 'agent-a06.jsonl'), '')
    assert.equal(await findAgentTranscript(session, 'plain'), path.join(dir, 's1', 'subagents', 'agent-plain.jsonl'))
    assert.equal(await findAgentTranscript(session, 'a06'), path.join(dir, 's1', 'subagents', 'workflows', 'wf_1', 'agent-a06.jsonl'))
    assert.equal(await findAgentTranscript(session, 'none'), undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // ── a detail kept current: posted when the transcript grows or the row changes, not otherwise ──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-'))
    const session = path.join(dir, 'sess.jsonl')
    fs.writeFileSync(session, '')
    fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true })
    const file = path.join(dir, 'sess', 'subagents', 'agent-ag1.jsonl')
    fs.writeFileSync(file, asText(transcriptRows.slice(0, 7)))
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'Explore', description: '找 flow matching' }))

    const board = new AgentBoard({ subscriptions: [] })
    board.titles.set('sess', { path: session, size: 0, custom: undefined, ai: '整理讀書筆記', isScanned: true, checkedAt: now, soughtAt: now })
    const row = { id: 'ag1', label: '找 flow matching', type: 'Explore', isListed: true, status: 'running', startedAt: now - 5_000, lastAt: now, steps: 1, lastAction: 'Read' }
    board.files.set('snap', { mtimeMs: 1, snapshot: { sessionId: 'sess', cwd: 'C:/vault', model: 'claude-opus-5-5', updatedAt: now, isClosed: false, agents: [row] } })

    const posted = []
    board.watchDetail('view', 'sess', 'ag1', 'sidebar', data => posted.push(data))
    await board.refreshDetails()
    assert.equal(posted.length, 1, JSON.stringify(posted.map(data => data.missing)))
    assert.equal(posted[0].key, 'sess:ag1')
    assert.equal(posted[0].agent.label, '找 flow matching')
    assert.equal(posted[0].session.name, '整理讀書筆記')
    assert.equal(posted[0].meta.agentType, 'Explore')
    assert.equal(posted[0].transcript.toolCount, 1)

    await board.refreshDetails()
    assert.equal(posted.length, 1, 'nothing changed: nothing posted')

    // it took two more steps
    fs.writeFileSync(file, asText(transcriptRows))
    await board.refreshDetails()
    assert.equal(posted.length, 2)
    assert.equal(posted[1].transcript.toolCount, 3)

    // it ended with words: the report is its last words, which leave the steps
    fs.appendFileSync(
      file,
      asText([
        { type: 'user', timestamp: at(12), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'a.md' }] } },
        { type: 'assistant', timestamp: at(13), requestId: 'r6', message: { role: 'assistant', content: [{ type: 'text', text: '找到 1 頁。' }] } },
      ]),
    )
    board.files.get('snap').snapshot.agents = [{ ...row, status: 'done', endedAt: now }]
    await board.refreshDetails()
    const last = posted[posted.length - 1]
    assert.equal(last.status, 'done')
    assert.deepEqual(last.transcript.output, { via: 'text', text: '找到 1 頁。', total: '找到 1 頁。'.length })
    assert.ok(!last.transcript.events.some(event => event.kind === 'text' && event.text === '找到 1 頁。'))

    // a page that just loaded asks again: it gets the detail though nothing changed
    const before = posted.length
    await board.repost(board.watches.get('view'))
    assert.equal(posted.length, before + 1)

    // a workflow's agent mid-run, which the mod knows only by id: named by its task's first line,
    // then by its run file's label once the run has ended
    fs.mkdirSync(path.join(dir, 'sess', 'subagents', 'workflows', 'wf_9'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'sess', 'subagents', 'workflows', 'wf_9', 'agent-wfa.jsonl'),
      asText([{ type: 'user', timestamp: at(0), message: { role: 'user', content: '## Survey recent papers on diffusion policies for manipulation\n\nCite each claim.' } }]),
    )
    const unnamed = { id: 'wfa', label: '未具名代理 wfa', type: '其他（workflow 等）', isListed: false, status: 'running', startedAt: now, lastAt: now, steps: 2, lastAction: 'WebSearch' }
    board.files.get('snap').snapshot.agents = [row, unnamed]
    await board.nameUnnamed(board.sessions())
    let shown = board.withWorkflow('sess', unnamed)
    assert.equal(shown.label, 'Survey recent papers on diffusion policies for m…')
    assert.equal(shown.type, 'workflow')
    fs.mkdirSync(path.join(dir, 'sess', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'sess', 'workflows', 'wf_9.json'),
      JSON.stringify({ runId: 'wf_9', workflowName: 'paper-survey', workflowProgress: [{ type: 'workflow_agent', agentId: 'wfa', label: 'survey:diffusion-policy', phaseTitle: 'Research', state: 'done' }] }),
    )
    board.workflowScannedAt.clear()
    await board.refreshWorkflows(board.sessions())
    shown = board.withWorkflow('sess', unnamed)
    assert.equal(shown.label, 'survey:diffusion-policy')
    assert.deepEqual(shown.workflow, { runId: 'wf_9', name: 'paper-survey', phase: 'Research' })

    // an agent whose transcript is not written yet: shown as missing
    const waiting = []
    board.watchDetail('other', 'sess', 'not-yet', 'sidebar', data => waiting.push(data))
    await board.refreshDetails()
    assert.equal(waiting[0].missing, true)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log('extension: all checks passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
