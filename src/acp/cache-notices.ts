// Port of pi 1.4.0 core/cache-stats.js and InteractiveMode's usage notices; pi's RPC mode emits none of them.

export const CACHE_TTL_MS = 5 * 60 * 1000
const NOISE_FLOOR_TOKENS = 1024

export type PiUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export type PiAssistantMessage = {
  role: 'assistant'
  provider: string
  model: string
  timestamp: number
  usage: PiUsage
  stopReason?: string
  diagnostics?: unknown
}

export type CacheMiss = { missedTokens: number; missedCost: number; idleMs: number; modelChanged: boolean }

type PreviousRequest = { promptTokens: number; modelKey: string; timestamp: number; reportedCache: boolean }

type Rec = Record<string, unknown>

function isRec(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function toUsage(x: unknown): PiUsage | undefined {
  if (!isRec(x) || !isRec(x.cost)) return undefined
  const { input, output, cacheRead, cacheWrite, cost } = x
  if (!isNum(input) || !isNum(output) || !isNum(cacheRead) || !isNum(cacheWrite)) return undefined
  if (!isNum(cost.input) || !isNum(cost.output) || !isNum(cost.cacheRead) || !isNum(cost.cacheWrite)) return undefined
  if (!isNum(cost.total)) return undefined
  return x as PiUsage
}

export function toAssistantMessage(x: unknown): PiAssistantMessage | undefined {
  if (!isRec(x) || x.role !== 'assistant') return undefined
  if (typeof x.provider !== 'string' || typeof x.model !== 'string' || !isNum(x.timestamp)) return undefined
  return toUsage(x.usage) ? (x as PiAssistantMessage) : undefined
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

function promptTokensOf(usage: PiUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite
}

// `modelCacheReadPerMillion` stands in for pi's `models.getModel(provider, model)?.cost.cacheRead`.
export function detectMiss(
  prev: PreviousRequest | undefined,
  message: PiAssistantMessage,
  modelCacheReadPerMillion: number | undefined
): CacheMiss | undefined {
  const usage = message.usage
  const promptTokens = promptTokensOf(usage)
  if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
    return undefined
  }
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined
  const paidTokens = usage.input + usage.cacheWrite
  const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0
  const readPerToken =
    usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : (modelCacheReadPerMillion ?? 0) / 1_000_000
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey
  }
}

export function formatCacheMissNotice(miss: CacheMiss): string | undefined {
  if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return undefined
  const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : ''
  const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`
  let label = 'Cache miss'
  if (miss.modelChanged) {
    label = 'Cache miss after model switch'
  } else if (miss.idleMs >= CACHE_TTL_MS) {
    label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`
  }
  return `${label}: ${reBilled}`
}

export function formatCompactionCostNotice(usage: PiUsage): string {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : ''
  return `Compaction: ${formatTokens(tokens)} tokens billed${cost}`
}

export function countDroppedThinkingBlocks(message: { diagnostics?: unknown }): number {
  let count = 0
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : []
  for (const diagnostic of diagnostics) {
    if (!isRec(diagnostic) || diagnostic.type !== 'anthropic_input_transformations') continue
    const transformations = isRec(diagnostic.details) ? diagnostic.details.transformations : undefined
    if (!Array.isArray(transformations)) continue
    count += transformations.filter(t => isRec(t) && t.type === 'thinking_dropped').length
  }
  return count
}

export type UsageNotice = { source: 'cacheMiss' | 'thinkingDropped'; text: string }

// Incremental form of cache-stats `scan()` over RPC `get_entries`, plus the parent links `getBranch()` walks.
export class UsageNoticeTracker {
  private prev: PreviousRequest | undefined
  private lastEntryId: string | undefined
  private readonly nodes = new Map<string, { parentId: string | null; droppedThinking?: number }>()

  get cursor(): string | undefined {
    return this.lastEntryId
  }

  reset(): void {
    this.prev = undefined
    this.lastEntryId = undefined
    this.nodes.clear()
  }

  // `message` may already be among `entries`: pi persists it right after emitting message_end.
  noticesFor(
    entries: unknown[],
    leafId: string | null,
    message: PiAssistantMessage,
    modelCacheReadPerMillion: number | undefined
  ): UsageNotice[] {
    const own = entries.findIndex(
      e =>
        isRec(e) &&
        e.type === 'message' &&
        isRec(e.message) &&
        e.message.role === 'assistant' &&
        e.message.timestamp === message.timestamp
    )
    for (const entry of own === -1 ? entries : entries.slice(0, own)) this.ingest(entry)

    const notices: UsageNotice[] = []
    const dropped = countDroppedThinkingBlocks(message)
    if (dropped > 0) {
      const ownEntry = own === -1 ? undefined : (entries[own] as Rec)
      const start = ownEntry ? (typeof ownEntry.parentId === 'string' ? ownEntry.parentId : null) : leafId
      if (dropped > this.previousDroppedOnBranch(start)) {
        const noun = dropped === 1 ? 'thinking block' : 'thinking blocks'
        notices.push({ source: 'thinkingDropped', text: `Anthropic dropped ${dropped} ${noun} (details in session)` })
      }
    }
    const miss = detectMiss(this.prev, message, modelCacheReadPerMillion)
    const missText = miss ? formatCacheMissNotice(miss) : undefined
    if (missText) notices.push({ source: 'cacheMiss', text: missText })

    if (own !== -1) for (const entry of entries.slice(own)) this.ingest(entry)
    return notices
  }

  private previousDroppedOnBranch(start: string | null): number {
    let id = start
    while (id) {
      const node = this.nodes.get(id)
      if (!node) break
      if (node.droppedThinking !== undefined) return node.droppedThinking
      id = node.parentId
    }
    return 0
  }

  private ingest(entry: unknown): void {
    if (!isRec(entry)) return
    if (typeof entry.id === 'string') {
      this.lastEntryId = entry.id
      const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
      const isAssistant = entry.type === 'message' && isRec(entry.message) && entry.message.role === 'assistant'
      this.nodes.set(entry.id, {
        parentId,
        ...(isAssistant ? { droppedThinking: countDroppedThinkingBlocks(entry.message as Rec) } : {})
      })
    }

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      this.prev = undefined
      return
    }
    if (entry.type === 'usage' && entry.kind === 'cache_warm') {
      const usage = toUsage(entry.usage)
      const promptTokens = usage ? promptTokensOf(usage) : 0
      if (promptTokens > 0) {
        this.prev = {
          promptTokens,
          modelKey: `${entry.provider}/${entry.model}`,
          timestamp: Date.parse(String(entry.timestamp)),
          reportedCache: true
        }
      }
      return
    }
    if (entry.type === 'message') {
      const message = toAssistantMessage(entry.message)
      if (!message) return
      const promptTokens = promptTokensOf(message.usage)
      if (promptTokens <= 0) return
      this.prev = {
        promptTokens,
        modelKey: `${message.provider}/${message.model}`,
        timestamp: message.timestamp,
        reportedCache: (this.prev?.reportedCache ?? false) || message.usage.cacheRead + message.usage.cacheWrite > 0
      }
    }
  }
}
