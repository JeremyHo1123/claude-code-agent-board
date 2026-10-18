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
  "account": { "id": "0a1b2c3d4e5f", "label": "the sign-in's email" },  // absent until the profile read answers
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

**`plan-<account id>.json`**, one for all sessions of an account: the shared read of the usage
endpoint. It is `plan.json` while a session does not know its account (`planFileOf`), which is also
what mods before 0.6.0 wrote.

```jsonc
{ "account": { "id": "0a1b2c3d4e5f", "label": "…" },
  "plan": { "fetchedAt": 0, "windows": [{ "key": "five_hour", "label": "…", "percent": 62, "resetsAt": "ISO" }], "extra": {} },
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
are left out. That is what drops stale readings after a reset or a change of account.

**Usage: never settle two accounts together.** VS Code signed in to one account and the desktop app
to another write into the same folder. Before 0.6.0 they shared one `plan.json` and one settling,
and the board showed whichever account replied last. The mod API gives no account id, so the mod
asks `GET /api/oauth/profile` through the same credential handle (`readAccount`; again every 10
minutes, for a sign-in changed mid-session) and puts `account` in its snapshot and in its account's
own shared file. `mergeUsage` groups every source by account id first and settles each group alone.
A source that names no account (a session that has not reloaded the mod, or whose profile read
fails) joins the account whose weekly window resets at the same time; what is left forms one
unnamed account. An account with no live session is not shown beside one that has. An
account whose every session runs in the desktop app is left out too, unless
`agentBoard.usageOfDesktopApp` is on: the extension reads each session's `entrypoint` from its
transcript (`claude-vscode`, `claude-desktop`, `cli`; every row carries it, and the last row read
counts: a conversation begun in the desktop app and resumed in VS Code is VS Code's), in the same read that
finds the title, so for the first seconds after a reload it is not known and such an account shows. The
email is personal data: it lives in the board's files only, and `live-smoke.js` prints the id, not it.

**Usage: a /login moves every session to another account at once.** The credential is shared, so
after `/login` each open session spends from the new account while it still names the old one. Until
0.7.3 that lasted up to the 10-minute recheck: its shared reads landed in the old account's file and
its replies' readings were filed under the old account, and the board showed two accounts with the
same figures. An account's weekly window ends at one time until it has ended, so a reading whose week
ends elsewhere while the earlier week still runs is another account's (`isAnotherAccountsWeek`). The
mod then asks the profile at once (`askAccount`): in `maybeReadPlan` before the read is written (only
the same account confirmed lets it into the file), and in `writeSnapshot` before a reply's reading is
filed. This costs no request until a week jumps. Two accounts whose weeks end within 10 minutes of
each other are not told apart this way; the recheck still catches them. A session that stopped
without closing (a window reload ends its process without `session.end`) stays on the board for
`KEEP_OPEN_MS` naming the account it last knew, so only a live session keeps an account shown.

**Usage: the extension words the windows itself.** The labels in a plan file are whatever the mod
of the session that last read it wrote, and sessions that have not reloaded keep an older mod: after
0.9.0 moved the interface to English, the board still showed the Chinese labels of 0.8.0 sessions.
So `windowLabelOf` names a window by its key and keeps a written label only for a key it does not know.

**One usage read for all sessions of an account.** Each session polling by itself got HTTP 429 from
the endpoint and left the board minutes behind. Hence the shared file, 30 seconds between reads, and a backoff that
doubles from 60 seconds to 10 minutes. Do not shorten the interval without measuring.

**Context: ask for the breakdown.** `$.session.usage()` alone gives the last reply's figure, which
trails a step. `$.session.usage({ breakdown: 'summary' })` gives `/context`'s estimate.

**Jumping to a prompt goes through find.** Nothing outside VS Code's Claude panel can scroll it. A
mod's `$.ui.scroll` needs the message id a `ui.render` hook sees, and that panel raises none: a
probe mod there read `$.session.surfaces()` as empty and saw no `UserMessage` drawn (2.1.296). The
Claude extension has no command for it either, and another extension cannot reach into its webview.
What the panel does have is VS Code's find (`enableFindWidget`). So `jumpToPrompt` copies the start
of the prompt's first line, activates the conversation's tab (`claudeTabOf`, by label; a tab is
shown by focusing its group and `workbench.action.openEditorAtIndex`), runs
`editor.action.webvieweditor.showFind`, waits 200 ms and runs `editor.action.clipboardPasteAction`.
No `selectAll` before the paste: should the find box not have taken focus, that would replace a
draft in Claude's input. Find sees only what is in the page, so a prompt the panel has not drawn is
not found. The prompts come from the transcript (`promptsIn`): user rows stamped
`origin.kind: "human"`, less the blocks the engine wrapped in a tag.

**Tab titles are cut.** The Claude extension labels a tab with the title cut to 24 characters plus
`…` when it is longer than 25, and `Claude Code` when there is none. `tabLabelOf` copies that rule.
If the rule changes upstream, focus-following silently stops working: look for `rename_tab` in the
Claude extension's webview code.

**Many conversations never get a title.** Until Claude Code writes an `ai-title` row, the tab is
labelled with the first prompt as typed; for many conversations (two in five on the machine this was
found on: most begun with a slash command or a pasted prompt) that row never comes, and the tab keeps
the prompt. Matching titles alone, such a tab only matched while it was the one untitled live
session. So `refreshTitles` reads an untitled transcript's first prompt from its head
(`firstPromptIn`: pasted text unwrapped, a slash command as `/name args`), and `isPromptLabel`
compares it with the label on its words only: the panel labels with the prompt as typed, line breaks
and all, and after a reload with the prompt as Claude Code lists it. Two conversations begun with the
same 24 characters carry the same label; the focus then stays where it was. The board names an
untitled conversation by that prompt's first line, as its tab does, not by its folder.

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
- **Everything is in English: interface strings, comments, identifiers, docs and test data.**
  Until 0.8.0 the interface was in Traditional Chinese; 0.9.0 moved it to English and dropped
  the Chinese README.
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
Check a change to the interface there, in both themes and at 300 px and 180 px wide, before packaging.
Headless Chrome will not go narrower than 500 px, so the pages take `?w=` for the sidebar's width.
`?debug=1` writes into the page title every element that shows past the sidebar's right edge (what
an ellipsis or a scrolling block clips is left out); read it with Chrome's `--headless=new --dump-dom`.
Below 250 px of board width each meter stacks its reset time under the bar, and below 440 px the
usage card has one column of `minmax(0, 1fr)`: a plain `1fr` lets the text widen the card past the sidebar.

## Releasing

1. Run every command above.
2. Set the version in three places: `.claude-plugin/plugin.json`, `vscode-extension/package.json`,
   and the badge and the Verify table in `README.md`.
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
(`/home/tester`, `Tidy up reading notes`). The two checks that read real data (`real-transcripts.js`,
`live-smoke.js`) print it and store none of it.
