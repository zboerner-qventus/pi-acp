import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v)
    else out[k] = v
  }
  return out
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    return isObject(data) ? data : {}
  } catch {
    return {}
  }
}

function getMergedSettings(cwd: string): Record<string, unknown> {
  const globalSettingsPath = join(getAgentDir(), 'settings.json')
  const projectSettingsPath = resolve(cwd, '.pi', 'settings.json')

  const global = readJsonFile(globalSettingsPath)
  const project = readJsonFile(projectSettingsPath)
  return deepMerge(global, project)
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.enableSkillCommands
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined
  if (typeof nested === 'boolean') return nested

  return true
}

// pi's RPC get_available_models ignores enabledModels scoping, so we replicate it here.
export function getEnabledModelPatterns(cwd: string): string[] | undefined {
  const merged = getMergedSettings(cwd)
  const patterns = merged.enabledModels
  if (!Array.isArray(patterns) || patterns.length === 0) return undefined
  return patterns.filter((p): p is string => typeof p === 'string')
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function stripThinkingSuffix(pattern: string): string {
  const idx = pattern.lastIndexOf(':')
  if (idx === -1) return pattern
  return THINKING_LEVELS.has(pattern.slice(idx + 1).toLowerCase()) ? pattern.slice(0, idx) : pattern
}

// Minimal glob matcher covering *, ?, [...] case-insensitively, mirroring pi's minimatch usage.
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        re += '\\['
        continue
      }
      re += pattern.slice(i, end + 1)
      i = end
    } else if ('.+^${}()|\\'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, 'i')
}

export function matchesEnabledModelPattern(provider: string, id: string, pattern: string): boolean {
  const fullId = `${provider}/${id}`
  const isGlob = /[*?[]/.test(pattern)
  const target = stripThinkingSuffix(pattern)
  if (!isGlob) return target.toLowerCase() === fullId.toLowerCase() || target.toLowerCase() === id.toLowerCase()
  const re = globToRegExp(target)
  return re.test(fullId) || re.test(id)
}

export function filterModelsByEnabledPatterns<T extends { provider: string; id: string }>(
  models: T[],
  cwd: string
): T[] {
  const patterns = getEnabledModelPatterns(cwd)
  if (!patterns) return models
  return models.filter(m => patterns.some(p => matchesEnabledModelPattern(m.provider, m.id, p)))
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.quietStartup
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used quietStart
  const legacy = (merged as any).quietStart
  if (typeof legacy === 'boolean') return legacy

  return false
}
