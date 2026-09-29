import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// Isolate from the real ~/.pi/agent/settings.json (e.g. a real enabledModels
// scope would otherwise filter out these fake 'test/*' models).
function withIsolatedAgentDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = dir
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for model and thinking selectors', () =>
  withIsolatedAgentDir(async () => {
    const realSetTimeout = globalThis.setTimeout
    ;(globalThis as any).setTimeout = () => 0 as any

    try {
      const conn = new FakeAgentSideConnection()
      const session = {
        sessionId: 's1',
        cwd: process.cwd(),
        proc: {
          async getAvailableThinkingLevels() {
            return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          },
          async getAvailableModels() {
            return {
              models: [
                { provider: 'test', id: 'alpha', name: 'Alpha' },
                { provider: 'test', id: 'beta', name: 'Beta' }
              ]
            }
          },
          async getState() {
            return {
              thinkingLevel: 'high',
              model: { provider: 'test', id: 'beta' }
            }
          }
        },
        setStartupInfo() {},
        sendStartupInfoIfPending() {}
      }

      const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
      ;(agent as any).sessions = new FakeSessions(session) as any

      const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

      assert.equal(result.models?.currentModelId, 'test/beta')
      assert.equal(result.modes?.currentModeId, 'high')
      assert.deepEqual(result.configOptions, [
        {
          type: 'select',
          id: 'model',
          category: 'model',
          name: 'Model',
          description: 'Select the model for this session',
          currentValue: 'test/beta',
          options: [
            { value: 'test/alpha', name: 'test/Alpha', description: null },
            { value: 'test/beta', name: 'test/Beta', description: null }
          ]
        },
        {
          type: 'select',
          id: 'thought_level',
          category: 'thought_level',
          name: 'Thinking',
          description: 'Set the reasoning effort for this session',
          currentValue: 'high',
          options: [
            { value: 'off', name: 'Thinking: off', description: null },
            { value: 'minimal', name: 'Thinking: minimal', description: null },
            { value: 'low', name: 'Thinking: low', description: null },
            { value: 'medium', name: 'Thinking: medium', description: null },
            { value: 'high', name: 'Thinking: high', description: null },
            { value: 'xhigh', name: 'Thinking: xhigh', description: null },
            { value: 'max', name: 'Thinking: max', description: null }
          ]
        }
      ])
    } finally {
      ;(globalThis as any).setTimeout = realSetTimeout
    }
  }))

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', () =>
  withIsolatedAgentDir(async () => {
    const conn = new FakeAgentSideConnection()
    const state = {
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'alpha' }
    }
    const setModelCalls: Array<{ provider: string; modelId: string }> = []

    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableThinkingLevels() {
          return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getState() {
          return state
        },
        async setModel(provider: string, modelId: string) {
          setModelCalls.push({ provider, modelId })
          state.model = { provider, id: modelId }
        }
      },
      async publishContextUsage() {
        // Context usage publishing is covered in test/unit/context-usage.test.ts.
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'model',
      value: 'test/beta'
    } as any)

    assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
    assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
    assert.deepEqual(conn.updates, [
      { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'medium' } },
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  }))

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', () =>
  withIsolatedAgentDir(async () => {
    const conn = new FakeAgentSideConnection()
    const state = {
      thinkingLevel: 'medium',
      model: { provider: 'test', id: 'alpha' }
    }
    const thinkingLevels: string[] = []

    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableThinkingLevels() {
          return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
        },
        async getAvailableModels() {
          return {
            models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
          }
        },
        async getState() {
          return state
        },
        async setThinkingLevel(level: string) {
          thinkingLevels.push(level)
          state.thinkingLevel = level
        }
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.setSessionConfigOption({
      sessionId: 's1',
      configId: 'thought_level',
      value: 'xhigh'
    } as any)

    assert.deepEqual(thinkingLevels, ['xhigh'])
    assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'xhigh')
    assert.deepEqual(conn.updates, [
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'xhigh'
        }
      },
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  }))
