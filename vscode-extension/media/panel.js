// Agent Board: one agent's task in an editor panel, wide and with everything open. The extension
// posts { type: 'detail', data } whenever the transcript grows or the agent's state changes.
;(function () {
  'use strict'

  const vscode = acquireVsCodeApi()
  const root = document.getElementById('detail')
  let data

  const state = window.AgentDetail.newState(draw)

  function draw() {
    if (data === undefined) {
      root.replaceChildren()
      return
    }
    window.AgentDetail.render(root, data, {
      wide: true,
      now: Date.now(),
      state,
      onCopy: text => vscode.postMessage({ type: 'copy', text }),
    })
  }

  window.addEventListener('message', event => {
    const message = event.data
    if (message && message.type === 'detail' && message.data) {
      data = message.data
      draw()
    }
  })

  setInterval(() => window.AgentDetail.tick(root, Date.now()), 1000)
  vscode.postMessage({ type: 'ready' })
})()
