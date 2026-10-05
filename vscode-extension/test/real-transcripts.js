// Parses the subagent transcripts on this machine the way a detail would (read-only) and prints a
// line per agent: its steps, errors, tokens and how it ended. A check of the parser against real rows.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const realLoad = Module._load
Module._load = function (request, ...rest) {
  return request === 'vscode' ? {} : realLoad.call(this, request, ...rest)
}
const { parseAgentTranscript, parseWorkflowRun, DETAIL_LIMITS } = require('../extension.js')

const root = path.join(os.homedir(), '.claude', 'projects')
const limit = Number(process.argv[2] || 12)
const files = []

function walk(folder, depth) {
  let entries = []
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory() && depth < 5) {
      walk(full, depth + 1)
    } else if (entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name) && full.includes(`${path.sep}subagents${path.sep}`)) {
      files.push({ full, mtimeMs: fs.statSync(full).mtimeMs })
    }
  }
}
walk(root, 0)
files.sort((a, b) => b.mtimeMs - a.mtimeMs)

let failures = 0
for (const { full } of files.slice(0, limit)) {
  const text = fs.readFileSync(full, 'utf8')
  const t = parseAgentTranscript(text, DETAIL_LIMITS.sidebar)
  const open = t.events.filter(event => event.kind === 'tool' && event.endAt === undefined).length
  const ended = t.output ? `report:${t.output.via}(${t.output.total})` : t.finalText ? `words(${t.finalText.total})` : t.failure ? `failure:${t.failure.slice(0, 40)}` : 'none'
  const tokens = t.usage.input + t.usage.cacheWrite + t.usage.output + t.usage.cacheRead
  const problems = []
  if (t.prompt === undefined) problems.push('NO PROMPT')
  if (t.startedAt === undefined) problems.push('NO TIME')
  if (t.events.some(event => event.kind === 'tool' && event.endAt !== undefined && event.endAt < event.at)) problems.push('NEGATIVE DURATION')
  failures += problems.length > 0 ? 1 : 0
  console.log(
    `${path.basename(full).slice(6, 16)} steps=${t.toolCount} open=${open} errors=${t.errorCount} say=${t.events.filter(e => e.kind === 'text').length} ` +
      `tokens=${tokens} out=${t.usage.output} model=${t.model || '-'} ended=${ended} prompt=${t.prompt ? t.prompt.length : 0}${problems.length ? ` !! ${problems.join(', ')}` : ''}`,
  )
}

const runs = []
function walkRuns(folder, depth) {
  let entries = []
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory() && depth < 4) {
      walkRuns(full, depth + 1)
    } else if (entry.isFile() && /^wf_.+\.json$/.test(entry.name) && path.basename(folder) === 'workflows') {
      runs.push(full)
    }
  }
}
walkRuns(root, 0)
for (const file of runs.slice(0, 4)) {
  const run = parseWorkflowRun(JSON.parse(fs.readFileSync(file, 'utf8')))
  console.log(`run ${run ? `${run.name} [${run.status}] phases=${run.phases.map(p => p.title).join('/')} agents=${run.agents.map(a => `${a.label}:${a.state}`).join(', ')}` : 'UNPARSED'}`)
}
console.log(`${Math.min(limit, files.length)} of ${files.length} transcripts parsed; ${failures} with problems`)
process.exitCode = failures > 0 ? 1 : 0
