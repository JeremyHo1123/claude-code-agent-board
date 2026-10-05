// Runs the extension's poll against the real ~/.claude/agent-board data (read-only), with a stand-in
// vscode module, and prints what the board would receive.
'use strict'

const Module = require('node:module')

const fakeVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {},
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    tabGroups: { activeTabGroup: { activeTab: undefined } },
  },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { executeCommand: () => Promise.resolve() },
}
const realLoad = Module._load
Module._load = function (request, ...rest) {
  return request === 'vscode' ? fakeVscode : realLoad.call(this, request, ...rest)
}

const { AgentBoard } = require('../extension.js')

async function main() {
  const board = new AgentBoard({ subscriptions: [] })
  // titles load two transcripts a poll
  for (let round = 0; round < 6; round += 1) {
    await board.poll()
  }
  const payload = JSON.parse(board.lastPayload)
  const now = Date.now()
  const age = at => `${Math.round((now - at) / 1000)}s`

  console.log('usage windows:')
  for (const window of payload.usage.list) {
    console.log(`  ${window.label.padEnd(10)} ${String(window.percent).padStart(5)}%  from ${window.source.padEnd(8)} ${age(window.at)} ago`)
  }
  console.log(`  planError: ${JSON.stringify(payload.usage.planError)}  planNextAt in ${payload.usage.planNextAt ? Math.round((payload.usage.planNextAt - now) / 1000) + 's' : '-'}`)
  console.log(`current: ${payload.currentSessionId} focused=${payload.isCurrentFocused}`)
  console.log('sessions:')
  for (const session of payload.sessions) {
    const usage = session.usage || {}
    const live = !session.isClosed && now - session.updatedAt < 180_000
    console.log(
      `  ${session.sessionId.slice(0, 8)} ${live ? 'live  ' : session.isClosed ? 'closed' : 'stale '} ` +
        `ctx=${usage.contextPercent ?? '-'}%${usage.isContextEstimate ? '(est)' : ''} ` +
        `mod=${'rateLimitsAt' in usage || usage.isContextEstimate !== undefined ? 'new' : 'old'} ` +
        `title=${session.title || '(none)'}`,
    )
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
