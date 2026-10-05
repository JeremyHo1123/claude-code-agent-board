export type AgentBoardStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentBoardTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AgentBoardRow = {
  /** The agent loop's id: what its tool.call / turn.complete events carry as agentId. */
  id: string
  label: string
  type: string
  /** True when the Agent tool started it (agent.spawn); false for loops seen only through their tool calls (workflow agents). */
  isListed: boolean
  status: AgentBoardStatus
  startedAt: number
  lastAt: number
  endedAt?: number
  steps: number
  lastAction: string
  tokens?: AgentBoardTokens
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': {
      rows: AgentBoardRow[]
      now: number
      isDismissed: boolean
    }
  }
}
