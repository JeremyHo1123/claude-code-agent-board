// Agent Board: one agent's task in detail, drawn from its transcript as the extension parsed it.
// Shared by the sidebar (compact, inside the board) and the editor panel (wide, everything open).
// Everything is built with DOM calls and textContent: transcript text never reaches innerHTML.
;(function () {
  'use strict'

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

  const pad = value => String(value).padStart(2, '0')

  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(seconds / 60)

    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
      : `${minutes}:${pad(seconds % 60)}`
  }

  /** A step's length: tenths under ten seconds, then whole seconds, then minutes. */
  function formatDuration(ms) {
    if (ms < 10_000) {
      return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
    }

    return ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatElapsed(ms)
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

  function modelOf(id) {
    const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(String(id || ''))
    if (match === null) {
      return String(id || '')
    }
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1)

    return match[3] === undefined ? `${name} ${match[2]}` : `${name} ${match[2]}.${match[3]}`
  }

  const STATE_LABEL = {
    running: '執行中',
    quiet: '暫無動作',
    lost: '可能已中斷',
    done: '完成',
    failed: '失敗',
    stopped: '已中止',
  }

  // ── token bar: three categorical slots, as the board's ended rows draw it ──

  function tokenBar(tokens) {
    const fresh = tokens.input + tokens.cacheWrite
    const parts = [
      ['k1', '新輸入', fresh],
      ['k2', '輸出', tokens.output],
      ['k3', '快取', tokens.cacheRead],
    ]
    const total = parts.reduce((sum, part) => sum + part[2], 0)

    const wrap = el('div', 'tokens')
    wrap.title = [
      `新輸入 ${formatInt(fresh)}（其中寫入快取 ${formatInt(tokens.cacheWrite)}）`,
      `輸出 ${formatInt(tokens.output)}`,
      `快取讀取 ${formatInt(tokens.cacheRead)}（重複讀取同一段內容，計費較低）`,
      `合計 ${formatInt(total)}`,
    ].join('\n')

    const bar = el('div', 'bar')
    for (const [key, , value] of parts) {
      if (value > 0) {
        const segment = el('span', `seg ${key}`)
        segment.style.flexGrow = String(value)
        bar.append(segment)
      }
    }

    const barLine = el('div', 'bar-line')
    barLine.append(bar, el('span', 'bar-total', `${formatTokens(total)} token`))

    const legend = el('div', 'legend')
    for (const [key, label, value] of parts) {
      const item = el('span', 'legend-item')
      item.append(el('span', `key ${key}`), document.createTextNode(`${label} ${formatTokens(value)}`))
      legend.append(item)
    }

    wrap.append(barLine, legend)

    return wrap
  }

  // ── markdown: the common subset an agent's report uses, as DOM ───

  /** Inline marks: `code`, **bold**, *italic*, [text](url). Anything else stays text. */
  function inline(parent, text) {
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|\[([^\]\n]+)\]\(([^)\s]+)\)/g
    let last = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) {
        parent.append(document.createTextNode(text.slice(last, match.index)))
      }
      if (match[1] !== undefined) {
        parent.append(el('code', 'md-code', match[1]))
      } else if (match[2] !== undefined) {
        const strong = el('strong')
        inline(strong, match[2])
        parent.append(strong)
      } else if (match[3] !== undefined) {
        const em = el('em')
        inline(em, match[3])
        parent.append(em)
      } else {
        // the address shows on hover; the webview never navigates away
        const link = el('span', 'md-link', match[4])
        link.title = match[5]
        parent.append(link)
      }
      last = match.index + match[0].length
    }
    if (last < text.length) {
      parent.append(document.createTextNode(text.slice(last)))
    }
  }

  const isTableRow = line => /^\s*\|.*\|\s*$/.test(line)
  const isTableRule = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
  const cellsOf = line =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map(cell => cell.trim().replace(/\\\|/g, '|'))

  function markdown(text) {
    const root = el('div', 'md')
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    let index = 0
    let paragraph = []

    const flush = () => {
      if (paragraph.length > 0) {
        const p = el('p')
        inline(p, paragraph.join('\n'))
        root.append(p)
        paragraph = []
      }
    }

    while (index < lines.length) {
      const line = lines[index]

      const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
      if (fence) {
        flush()
        const body = []
        index += 1
        while (index < lines.length && !lines[index].trim().startsWith(fence[1])) {
          body.push(lines[index])
          index += 1
        }
        index += 1
        const pre = el('pre', 'md-pre')
        pre.append(el('code', '', body.join('\n')))
        root.append(pre)
        continue
      }

      if (line.trim() === '') {
        flush()
        index += 1
        continue
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
      if (heading) {
        flush()
        const node = el(`h${Math.min(6, heading[1].length + 2)}`, 'md-h')
        inline(node, heading[2].replace(/\s+#+\s*$/, ''))
        root.append(node)
        index += 1
        continue
      }

      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        flush()
        root.append(el('hr', 'md-hr'))
        index += 1
        continue
      }

      if (isTableRow(line) && index + 1 < lines.length && isTableRule(lines[index + 1])) {
        flush()
        const table = el('table', 'md-table')
        const head = el('tr')
        for (const cell of cellsOf(line)) {
          const th = el('th')
          inline(th, cell)
          head.append(th)
        }
        const thead = el('thead')
        thead.append(head)
        const tbody = el('tbody')
        index += 2
        while (index < lines.length && isTableRow(lines[index])) {
          const row = el('tr')
          for (const cell of cellsOf(lines[index])) {
            const td = el('td')
            inline(td, cell)
            row.append(td)
          }
          tbody.append(row)
          index += 1
        }
        table.append(thead, tbody)
        const scroller = el('div', 'md-table-wrap')
        scroller.append(table)
        root.append(scroller)
        continue
      }

      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (item) {
        flush()
        const isOrdered = /\d/.test(item[2])
        const list = el(isOrdered ? 'ol' : 'ul', 'md-list')
        while (index < lines.length) {
          const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
          if (!current) {
            // a wrapped line of the item before
            if (lines[index].trim() !== '' && /^\s{2,}/.test(lines[index]) && list.lastChild) {
              list.lastChild.append(document.createTextNode(`\n${lines[index].trim()}`))
              index += 1
              continue
            }
            break
          }
          const li = el('li')
          if (current[1].length >= 2) {
            li.className = 'md-nested'
          }
          inline(li, current[3])
          list.append(li)
          index += 1
        }
        root.append(list)
        continue
      }

      const quote = /^\s*>\s?(.*)$/.exec(line)
      if (quote) {
        flush()
        const body = []
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          body.push(lines[index].replace(/^\s*>\s?/, ''))
          index += 1
        }
        const block = el('blockquote', 'md-quote')
        inline(block, body.join('\n'))
        root.append(block)
        continue
      }

      paragraph.push(line)
      index += 1
    }
    flush()

    return root
  }

  // ── the detail ───────────────────────────────────────────────────

  /**
   * One collapsible section: a header button and a body. `state.closed` keeps which sections the
   * person folded, across redraws.
   */
  function section(id, title, count, state, build, extra) {
    const node = el('section', 'd-section')
    const isOpen = !state.closed.has(id)
    const head = el('button', 'd-section-head')
    head.type = 'button'
    head.setAttribute('aria-expanded', String(isOpen))
    head.append(el('span', 'chev', '▼'), el('span', '', title))
    if (count !== undefined) {
      head.append(el('span', 'count', String(count)))
    }
    head.addEventListener('click', () => {
      if (state.closed.has(id)) {
        state.closed.delete(id)
      } else {
        state.closed.add(id)
      }
      state.redraw()
    })
    const bar = el('div', 'd-section-bar')
    bar.append(head)
    if (extra) {
      bar.append(extra)
    }
    node.append(bar)
    if (isOpen) {
      const body = el('div', 'd-section-body')
      build(body)
      node.append(body)
    }

    return node
  }

  /** A block of text that shows its first lines until the person asks for the rest. */
  function foldedText(text, lines, state, id, className) {
    const wrap = el('div', 'd-fold')
    const pre = el('pre', className || 'd-pre', text)
    const isLong = text.split('\n').length > lines || text.length > lines * 90
    if (isLong && !state.unfolded.has(id)) {
      pre.classList.add('is-folded')
      pre.style.setProperty('--lines', String(lines))
      const more = el('button', 'd-more', '顯示全部')
      more.type = 'button'
      more.addEventListener('click', () => {
        state.unfolded.add(id)
        state.redraw()
      })
      wrap.append(pre, more)
    } else {
      wrap.append(pre)
    }

    return wrap
  }

  const TOOL_GLYPH = { ok: '✓', error: '✕', running: '●', open: '○' }

  function stepState(step, isLive) {
    if (step.endAt !== undefined) {
      return step.isError ? 'error' : 'ok'
    }

    return isLive ? 'running' : 'open'
  }

  function stepRow(step, origin, now, isLive, state, wide) {
    const status = stepState(step, isLive)
    const isOpen = state.expanded.has(step.id)
    const row = el('li', `d-step is-${status}${isOpen ? ' is-open' : ''}`)

    const line = el('button', 'd-step-line')
    line.type = 'button'
    line.setAttribute('aria-expanded', String(isOpen))
    const offset = el('span', 'd-step-at', `+${formatElapsed(step.at - origin)}`)
    offset.title = clockOf(step.at)
    const tool = el('span', 'd-step-tool', step.name)
    const summary = el('span', 'd-step-summary', step.summary || '')
    summary.title = step.summary || ''
    const took = el(
      'span',
      'd-step-took',
      step.endAt !== undefined ? formatDuration(step.endAt - step.at) : status === 'running' ? formatDuration(now - step.at) : '',
    )
    if (status === 'running') {
      took.dataset.since = String(step.at)
    }
    line.append(el('span', `d-step-glyph g-${status}`, TOOL_GLYPH[status]), offset, tool, summary, took)
    line.addEventListener('click', () => {
      if (state.expanded.has(step.id)) {
        state.expanded.delete(step.id)
      } else {
        state.expanded.add(step.id)
      }
      state.redraw()
    })
    row.append(line)

    if (isOpen) {
      const body = el('div', 'd-step-body')
      if (step.input) {
        body.append(el('div', 'd-label', '輸入'), foldedText(step.input, wide ? 30 : 10, state, `${step.id}:in`, 'd-pre is-code'))
      }
      if (step.endAt !== undefined) {
        const label = el('div', 'd-label', step.isError ? '錯誤' : '結果')
        if (step.resultTotal > step.result.length) {
          label.append(el('span', 'd-label-note', `（只顯示前 ${formatInt(step.result.length)} 字，共 ${formatInt(step.resultTotal)} 字）`))
        }
        body.append(label, foldedText(step.result || '（沒有內容）', wide ? 40 : 12, state, `${step.id}:out`, `d-pre is-code${step.isError ? ' is-error' : ''}`))
      } else {
        body.append(el('div', 'd-note', status === 'running' ? '還在執行，結果回來後會出現在這裡。' : '這一步沒有結果（子代理在它完成前就結束了）。'))
      }
      row.append(body)
    }

    return row
  }

  /**
   * Draws `data` into `root`: { agent, session, workflow, transcript, missing, error }, the agent's
   * live row merged with its parsed transcript. `options`: { wide, now, state, onBack, onOpenPanel, onCopy }.
   */
  function render(root, data, options) {
    const { wide, now, state } = options
    const agent = data.agent || {}
    const transcript = data.transcript
    const status = data.status || agent.status || 'running'
    const isLive = status === 'running' || status === 'quiet'
    const nodes = []

    // the bar: back, and the way out to the wide view
    if (options.onBack || options.onOpenPanel) {
      const bar = el('div', 'd-bar')
      if (options.onBack) {
        const back = el('button', 'd-button is-ghost', '← 返回')
        back.type = 'button'
        back.addEventListener('click', options.onBack)
        bar.append(back)
      }
      if (options.onOpenPanel && transcript) {
        const open = el('button', 'd-button', '在編輯區開啟')
        open.type = 'button'
        open.title = '用整個編輯區顯示完整的任務細節'
        open.addEventListener('click', options.onOpenPanel)
        bar.append(open)
      }
      nodes.push(bar)
    }

    // the heading: state, name, how long
    const head = el('header', `d-head is-${status}`)
    const titleLine = el('div', 'line')
    const elapsed = el('span', 'elapsed end')
    const startedAt = agent.startedAt || (transcript && transcript.startedAt)
    const endedAt = isLive ? undefined : agent.endedAt || (transcript && transcript.lastAt)
    if (startedAt) {
      elapsed.textContent = formatElapsed((endedAt || now) - startedAt)
      if (!endedAt) {
        elapsed.dataset.since = String(startedAt)
        elapsed.dataset.format = 'elapsed'
      }
    }
    const title = el('h1', 'd-title body', agent.label || (data.meta && data.meta.description) || '子代理')
    titleLine.append(el('span', 'dot lead'), title, elapsed)
    head.append(titleLine)

    const facts = [
      STATE_LABEL[status] || status,
      agent.type || (data.meta && data.meta.agentType),
      modelOf((transcript && transcript.model) || ''),
      transcript ? `${transcript.toolCount} 步` : agent.steps !== undefined ? `${agent.steps} 步` : undefined,
    ].filter(Boolean)
    const factLine = el('div', 'line')
    factLine.append(el('span', 'meta body', facts.join(' · ')))
    head.append(factLine)

    const tags = []
    if (data.workflow) {
      tags.push(`${data.workflow.name}${data.workflow.phase ? ` · ${data.workflow.phase}` : ''}`)
    }
    if (data.session && data.session.name) {
      tags.push(data.session.name)
    }
    if (tags.length > 0) {
      const tagLine = el('div', 'line')
      const holder = el('span', 'body d-tags')
      for (const tag of tags) {
        const node = el('span', 'tag is-lead', tag)
        node.title = tag
        holder.append(node)
      }
      tagLine.append(holder)
      head.append(tagLine)
    }
    nodes.push(head)

    if (data.missing) {
      nodes.push(
        el(
          'div',
          'd-callout',
          data.error ||
            '還找不到這個子代理的紀錄檔。剛派出的子代理，紀錄要等它第一次回應後才會寫入；舊的對話若已清除，也會找不到。',
        ),
      )
      root.replaceChildren(...nodes)

      return
    }

    // what it does now, or how it ended
    const events = transcript.events
    const running = isLive ? [...events].reverse().find(event => event.kind === 'tool' && event.endAt === undefined) : undefined
    if (running) {
      const now_ = el('div', 'd-now')
      const took = el('span', 'd-now-took', formatDuration(now - running.at))
      took.dataset.since = String(running.at)
      now_.append(el('span', 'd-now-label', '現在'), el('span', 'd-step-tool', running.name), el('span', 'd-now-summary', running.summary || ''), took)
      nodes.push(now_)
    } else if (isLive) {
      nodes.push(el('div', 'd-now is-thinking', '正在思考下一步…'))
    }
    if (transcript.failure) {
      nodes.push(el('div', 'd-callout is-crit', transcript.failure))
    } else if (status === 'failed') {
      nodes.push(el('div', 'd-callout is-crit', '這個子代理失敗了；最後幾步的錯誤在下方「過程」裡，以 ✕ 標出。'))
    } else if (status === 'stopped') {
      nodes.push(el('div', 'd-callout', '這個子代理在完成前被中止。'))
    }

    // the figures
    const tiles = el('div', 'd-tiles')
    const tile = (value, label, hint) => {
      const node = el('div', 'd-tile')
      node.append(el('div', 'd-tile-value', value), el('div', 'd-tile-label', label))
      if (hint) {
        node.title = hint
      }
      return node
    }
    const usage = transcript.usage
    const total = usage.input + usage.cacheWrite + usage.output + usage.cacheRead
    tiles.append(
      tile(String(transcript.toolCount), '步', '呼叫工具的次數'),
      tile(transcript.errorCount > 0 ? String(transcript.errorCount) : '0', '錯誤', '回傳錯誤的步數'),
      tile(formatTokens(total), 'token', `輸入 ${formatInt(usage.input + usage.cacheWrite)}，輸出 ${formatInt(usage.output)}，快取讀取 ${formatInt(usage.cacheRead)}`),
    )
    if (transcript.thinkingMs > 0) {
      tiles.append(tile(formatDuration(transcript.thinkingMs), '思考', '模型思考花的時間（合計）'))
    }
    nodes.push(tiles)
    if (total > 0) {
      nodes.push(tokenBar({ input: usage.input, cacheWrite: usage.cacheWrite, output: usage.output, cacheRead: usage.cacheRead }))
    }

    // the task it was given
    if (transcript.prompt) {
      nodes.push(
        section('prompt', '任務指示', undefined, state, body => {
          body.append(foldedText(transcript.prompt, wide ? 40 : 9, state, 'prompt', 'd-pre'))
        }),
      )
    }

    // the steps, with what it said between them
    const origin = transcript.startedAt || startedAt || now
    nodes.push(
      section('steps', '過程', transcript.toolCount, state, body => {
        if (transcript.eventsDropped > 0) {
          body.append(el('div', 'd-note', `較早的 ${formatInt(transcript.eventsDropped)} 筆沒有列出，只顯示最近的部分。`))
        }
        if (events.length === 0) {
          body.append(el('div', 'd-note', isLive ? '還沒有任何步驟。' : '這個子代理沒有呼叫任何工具。'))
          return
        }
        const list = el('ol', 'd-steps')
        for (const event of events) {
          if (event.kind === 'tool') {
            list.append(stepRow(event, origin, now, isLive, state, wide))
          } else {
            const say = el('li', 'd-say')
            const text = el('div', 'd-say-text', event.text)
            if (!wide && !state.unfolded.has(`say:${event.at}`)) {
              text.classList.add('is-folded')
              text.style.setProperty('--lines', '2')
              text.title = '按一下顯示全部'
              text.addEventListener('click', () => {
                state.unfolded.add(`say:${event.at}`)
                state.redraw()
              })
            }
            say.append(text)
            list.append(say)
          }
        }
        body.append(list)
      }),
    )

    // what it handed back
    if (transcript.output) {
      const copy = options.onCopy ? el('button', 'd-button is-small', '複製') : undefined
      if (copy) {
        copy.type = 'button'
        copy.addEventListener('click', event => {
          event.stopPropagation()
          options.onCopy(transcript.output.text)
        })
      }
      const label = transcript.output.via === 'structured' ? '回報（結構化結果）' : '回報'
      nodes.push(
        section(
          'output',
          label,
          undefined,
          state,
          body => {
            if (transcript.output.via === 'structured') {
              body.append(foldedText(transcript.output.text, wide ? 60 : 16, state, 'output', 'd-pre is-code'))
            } else {
              body.append(markdown(transcript.output.text))
            }
            if (transcript.output.total > transcript.output.text.length) {
              const shown = `只顯示前 ${formatInt(transcript.output.text.length)} 字，共 ${formatInt(transcript.output.total)} 字`
              body.append(el('div', 'd-note', wide ? `${shown}。` : `${shown}；按上方「在編輯區開啟」可看到更多。`))
            }
          },
          copy,
        ),
      )
    } else if (!isLive) {
      nodes.push(el('div', 'd-note', '這個子代理沒有留下回報。'))
    }

    if (transcript.truncated) {
      nodes.push(el('div', 'd-note', '紀錄檔很大，只讀了開頭（任務指示）和最近的部分。'))
    }

    root.replaceChildren(...nodes)
  }

  /** The figures that run with the clock: elapsed times on the heading, the running step, the now-line. */
  function tick(root, now) {
    for (const node of root.querySelectorAll('[data-since]')) {
      const since = Number(node.dataset.since)
      node.textContent = node.dataset.format === 'elapsed' ? formatElapsed(now - since) : formatDuration(now - since)
    }
  }

  function newState(redraw) {
    return { closed: new Set(), expanded: new Set(), unfolded: new Set(), redraw }
  }

  window.AgentDetail = { render, tick, newState, markdown, tokenBar, formatElapsed, formatTokens, modelOf }
})()
