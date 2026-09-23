import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterModelsByEnabledPatterns, matchesEnabledModelPattern } from '../../src/acp/pi-settings.js'

test('matchesEnabledModelPattern: glob prefixes match provider/id or bare id, case-insensitively', () => {
  assert.equal(matchesEnabledModelPattern('amazon-bedrock', 'us.anthropic.claude-sonnet-5', 'us.*'), true)
  assert.equal(matchesEnabledModelPattern('amazon-bedrock', 'eu.anthropic.claude-sonnet-5', 'us.*'), false)
  assert.equal(matchesEnabledModelPattern('google-vertex', 'gemini-3.5-flash', 'gemini-3.*-flash*'), true)
  assert.equal(matchesEnabledModelPattern('github-copilot', 'GPT-4O', 'github-copilot/*'), true)
})

test('matchesEnabledModelPattern: exact (non-glob) patterns match ignoring a trailing thinking-level suffix', () => {
  assert.equal(matchesEnabledModelPattern('anthropic', 'sonnet', 'anthropic/sonnet:high'), true)
  assert.equal(matchesEnabledModelPattern('anthropic', 'sonnet', 'sonnet'), true)
  assert.equal(matchesEnabledModelPattern('anthropic', 'sonnet', 'haiku'), false)
})

test('filterModelsByEnabledPatterns: no-op when enabledModels is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    const models = [
      { provider: 'test', id: 'alpha' },
      { provider: 'test', id: 'beta' }
    ]
    assert.deepEqual(filterModelsByEnabledPatterns(models, process.cwd()), models)
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filterModelsByEnabledPatterns: scopes to enabledModels glob patterns from settings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['us.*'] }))
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  try {
    const models = [
      { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-5' },
      { provider: 'amazon-bedrock', id: 'eu.anthropic.claude-sonnet-5' }
    ]
    assert.deepEqual(filterModelsByEnabledPatterns(models, process.cwd()), [models[0]])
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
