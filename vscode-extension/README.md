# Agent Board

A live board for Claude Code inside VS Code: every conversation's subagents and their task
details, your subscription usage, and the context fill of the conversation in view.

VS Code's Claude Code extension draws no mod pane, so the data comes from the **agent-board mod**
(a Claude Code plugin of function hooks), which writes one JSON snapshot per session into
`~/.claude/agent-board/`. This extension reads that folder once a second.

Setup, screenshots and how it works:
<https://github.com/JeremyHo1123/claude-code-agent-board>

- Open it from the Agent Board icon in the activity bar, or run **Agent Board: 打開子代理面板**.
- Click a subagent's card or row for its task detail; **在編輯區開啟** opens it wide in an editor tab.
- The status bar shows subscription usage (`5h % · 週 %`) and the current conversation's context.
- Settings live under `agentBoard.*`.

The interface is in Traditional Chinese.
