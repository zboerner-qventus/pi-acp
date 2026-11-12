import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent, PiSessionStats } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  // elicitation (unstable) spy
  readonly elicitationRequests: unknown[] = []
  elicitationResponse: any = { action: 'accept', content: { value: 'my answer' } }
  elicitationError: Error | null = null

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async unstable_createElicitation(params: any): Promise<any> {
    this.elicitationRequests.push(params)
    if (this.elicitationError) throw this.elicitationError
    return this.elicitationResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly steers: string[] = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  getSessionStatsCount = 0

  sessionStats: PiSessionStats = {}
  /** When set, `getSessionStats()` rejects with this error. */
  sessionStatsError: unknown = null
  // When set, the next prompt() call rejects with this error (then resets).
  nextPromptError: Error | null = null

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
    if (this.nextPromptError) {
      const err = this.nextPromptError
      this.nextPromptError = null
      throw err
    }
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async steer(message: string): Promise<void> {
    this.steers.push(message)
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return { thinkingLevel: 'medium' }
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return ['medium', 'high']
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  // Mirrors pi's RPC `get_entries`: entries after `since`, error when `since` is unknown.
  entries: Array<{ id: string } & Record<string, unknown>> = []
  getEntriesCalls: Array<string | undefined> = []

  async getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
    this.getEntriesCalls.push(since)
    let entries = this.entries
    if (since !== undefined) {
      const i = entries.findIndex(e => e.id === since)
      if (i === -1) throw new Error(`pi get_entries failed: Entry not found: ${since}`)
      entries = entries.slice(i + 1)
    }
    return { entries, leafId: this.entries.at(-1)?.id ?? null }
  }

  async getSessionStats(): Promise<PiSessionStats> {
    this.getSessionStatsCount += 1
    if (this.sessionStatsError) throw this.sessionStatsError
    return this.sessionStats
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
