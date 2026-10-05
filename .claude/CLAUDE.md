# Agent Board: notes for whoever works on this

Agent Board shows Claude Code's subagents, subscription usage and context fill inside VS Code.
It is two programs that meet at a folder of JSON files. Read the README first for what it does;
this file is what you need to change it without breaking it.

## The two halves

| | The mod | The extension |
|---|---|---|
| Where | the repository root (`hooks/`, `types/`, `tests/`) | `vscode-extension/` |
| Runs in | every Claude Code session, as a plugin of function hooks | VS Code's extension host, plus two webviews |
| Language | TypeScript/TSX, no Node, no DOM: only `$` reaches outside | plain JavaScript, no dependencies, no build step |
| Job | observe the session, write files | read files, draw |

They never talk to each other directly. The contract between them is the files below.

**Why two halves:** VS Code's Claude Code extension draws no mod interface (no `ui_render`
surface, checked up to 2.1.289). A mod's `Pane` and its `AbovePrompt` band appear in the terminal
and the desktop app only. `$.ui.open` still answers `isPlaced: true` there, so do not trust it.
Another extension cannot draw inside the Claude panel's webview either, and that panel shows no
custom status line. This is why the context fill lives in VS Code's status bar.

## The files

Everything is under `<claude dir>/agent-board/`, where `<claude dir>` is `CLAUDE_CONFIG_DIR` when
set and `~/.claude` otherwise. The mod resolves it in `boardRootOf` (`hooks/format.ts`) from
environment variables, because the hooks environment has no `os`; the extension resolves the same
folder in `claudeDirectory()`.

**`sessions/<sessionId>.json`**, one per session, written by the mod (`writeSnapshot`):

```jsonc
{
  "version": 1,
  "sessionId": "…", "cwd": "…", "model": "claude-…",
  "updatedAt": 0,          // ms; a session is "live" while this is under 3 minutes old
  "isClosed": false,
  "usage": {
    "contextPercent": 34, "contextTokens": 341000, "contextWindow": 1000000,
    "isContextEstimate": true,              // true: /context's own estimate
    "rateLimits": [{ "kind": "five_hour", "percentUsed": 62, "resetsAt": "ISO" }],
    "rateLimitsAt": 0                       // ms: when the last API reply was seen
  },
  "activity": { "state": "working|waiting|idle", "since": 0, "reason": "…", "kind": "question|permission" },
  "agents": [{ "id": "…", "label": "…", "type": "…", "isListed": true, "status": "running|done|failed|stopped",
               "startedAt": 0, "lastAt": 0, "endedAt": 0, "steps": 0, "lastAction": "…", "tokens": {} }]
}
```

**`plan.json`**, one for all sessions: the shared read of the usage endpoint.

```jsonc
{ "plan": { "fetchedAt": 0, "windows": [{ "key": "five_hour", "label": "…", "percent": 62, "resetsAt": "ISO" }], "extra": {} },
  "nextAttemptAt": 0, "lastAttemptAt": 0, "lastError": { "at": 0, "status": 429 }, "failures": 1 }
```

A session that finds `nextAttemptAt` passed claims the read by writing a new `nextAttemptAt`
first, then fetches, then writes the answer. `lastError` is present only while the last read failed.

**Files Claude Code writes, which the extension only reads:**

- `<claude dir>/projects/<project>/<sessionId>.jsonl`: the session's transcript. Its
  `custom-title` and `ai-title` rows give the conversation's title.
- `…/<sessionId>/subagents/agent-<agentId>.jsonl`: a subagent's transcript. A workflow's agents
  are one level down: `…/subagents/workflows/<runId>/agent-<agentId>.jsonl`. The mod's agent id
  is the id in that file name.
- `…/<sessionId>/workflows/<runId>.json`: a workflow run, with each agent's label, phase and state.

## Things learned the hard way

**Usage: show the highest reading, not the newest.** A reply's rate-limit figure is as of before
its own request was counted, and knows nothing of what other sessions spent since. Three readings
taken within seconds of each other were 11%, 10% and 7%. Use within a window only grows, so
`settleWindow` (extension) takes the highest reading of the window in force. Which window is in
force is decided by the latest reading that names one, and replies older than the last usage read
are left out. That is what drops stale readings after a reset or a change of account. There is no
account id to key on: the mod API gives none.

**One usage read for all sessions.** Each session polling by itself got HTTP 429 from the endpoint
and left the board minutes behind. Hence `plan.json`, 30 seconds between reads, and a backoff that
doubles from 60 seconds to 10 minutes. Do not shorten the interval without measuring.

**Context: ask for the breakdown.** `$.session.usage()` alone gives the last reply's figure, which
trails a step. `$.session.usage({ breakdown: 'summary' })` gives `/context`'s estimate.

**Tab titles are cut.** The Claude extension labels a tab with the title cut to 24 characters plus
`…` when it is longer than 25, and `Claude Code` when there is none. `tabLabelOf` copies that rule.
If the rule changes upstream, focus-following silently stops working: look for `rename_tab` in the
Claude extension's webview code.

**Transcript rows.** What `parseAgentTranscript` relies on:

- The first user row that is not `isMeta` is the task.
- One reply is several rows (a thinking row, a text row, a tool_use row). Each carries the reply's
  usage as it stood, and only the last is complete. Count usage once per `requestId`, at its
  largest `output_tokens`.
- A tool's result is a `tool_result` block in a later user row, with `is_error`.
- A subagent hands its report back through a `SubagentHandback` tool call (`input.message`). A
  workflow's agent uses `StructuredOutput`. With neither, the last text is the answer.
- An API failure (a usage limit, say) is an assistant row with `isApiErrorMessage` and the model `<synthetic>`.
- Thinking blocks are empty: only a signature is kept.

**Workflow labels arrive late.** The run file is written when the run ends. Mid-run nothing on
disk names the agents, so `nameUnnamed` uses the first line of each agent's task until then.

**The hooks environment's clock is not the person's time zone.** The mod prints no clock times.

**Webviews miss early messages.** A page that has just loaded did not hear what was posted before
it listened. Both webviews post `ready`, and the extension answers with `repost`.

## Rules the code follows

- **Transcript text never reaches `innerHTML`.** `media/detail.js` builds everything with DOM
  calls and `textContent`, including its Markdown renderer. Keep it that way.
- **Keyed updates in the board.** Running cards and meters are updated in place, so their
  animations do not restart every second. Do not replace them wholesale.
- **The first poll is a baseline.** `notify` announces changes, never the state it found at startup.
- **Interface strings are Traditional Chinese; comments and identifiers are English.**
- **No dependencies in the extension.** It ships as source in the package.
- **The mod names environment variables as string literals** (`$.env.get('HOME')`), so
  `claude plugin validate` can list them.

## Commands

The mod, from the repository root. `tsc` needs the types Claude Code lays into
`.claude-plugin/types/` the first time the mod loads.

```bash
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.8 tsc -p . --noEmit
```

Use a `claude` binary at least as new as the sessions you run. The VS Code extension bundles its
own, which can be newer than the one on PATH:
`~/.vscode/extensions/anthropic.claude-code-<version>-<platform>/resources/native-binary/claude`.
If `plugin test` says the rollout switch is off, try again later; `validate` and `tsc` are unaffected.

The extension, from `vscode-extension/`:

```bash
node test/extension.test.js       # must print: extension: all checks passed
node test/real-transcripts.js 30  # read-only, over this machine's real transcripts
node test/live-smoke.js           # read-only, one poll over this machine's real snapshots
```

`preview/index.html` and `preview/panel.html` show the webviews in a browser with made-up data.
Check a change to the interface there, in both themes and at 300 px wide, before packaging.
Headless Chrome will not go narrower than 500 px, so the pages take `?w=` for the sidebar's width.

## Releasing

1. Run every command above.
2. Set the version in three places: `.claude-plugin/plugin.json`, `vscode-extension/package.json`,
   and the badge and the Verify table in both READMEs.
3. Rebuild the package and install it:
   ```bash
   cd vscode-extension
   npx -y @vscode/vsce@latest package --no-dependencies --skip-license -o ../dist/agent-board.vsix
   code --install-extension ../dist/agent-board.vsix --force
   ```
4. Retake the screenshots if the interface changed (`preview/shoot.sh`), into `docs/images/`.
5. Commit and tag `v<version>`.

An interactive session watches the folder and reloads the mod by itself; one that is mid-turn
does so when the turn ends. The extension needs **Developer: Reload Window**.

## Keep personal data out

This repository is meant to be shared. Nothing personal goes in: no real home-folder paths, no
real conversation titles, no session ids, no tokens. Tests and preview data use made-up names
(`/home/tester`, `整理讀書筆記`). The two checks that read real data (`real-transcripts.js`,
`live-smoke.js`) print it and store none of it.
