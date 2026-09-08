import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const settle = () => new Promise(r => setTimeout(r, 0))

// pi-permission-system gates a bash call by folding its message into the `ui.select` title.
const PERMISSION_TITLE =
  "Permission Required\nCurrent agent requested bash command 'cd /tmp' (matched '*') (full command: 'cd /tmp && ls'). Allow this command?"

test('PiAcpSession: renders a permission prompt on the tool call being gated', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'cd /tmp && ls' } })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: PERMISSION_TITLE,
    options: ['Yes', 'Yes, for this session', 'No', 'No, provide reason']
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 't1', 'prompt is attached to the live tool call, not a synthetic one')
  assert.equal(request.toolCall.title, 'cd /tmp && ls')
  assert.equal(request.toolCall.status, 'in_progress')
  assert.deepEqual(request.toolCall.content, [
    // The terminal block must survive, or the client loses the bash output view.
    { type: 'terminal', terminalId: 't1' },
    {
      type: 'content',
      content: {
        type: 'text',
        text: "Current agent requested bash command 'cd /tmp' (matched '*') (full command: 'cd /tmp && ls'). Allow this command?"
      }
    }
  ])
})

test('PiAcpSession: classifies permission option kinds from their labels', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Permission Required\nAllow?',
    options: ['Yes', 'Yes, for this session', 'No', 'No, provide reason']
  })

  await settle()

  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'choice-0', name: 'Yes', kind: 'allow_once' },
    { optionId: 'choice-1', name: 'Yes, for this session', kind: 'allow_always' },
    { optionId: 'choice-2', name: 'No', kind: 'reject_once' },
    { optionId: 'choice-3', name: 'No, provide reason', kind: 'reject_once' }
  ])
})

test('PiAcpSession: clears the prompt from the tool call once it is answered', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: PERMISSION_TITLE,
    options: ['Yes', 'No']
  })

  await settle()
  await settle()

  const last = conn.updates.at(-1)!.update as any
  assert.equal(last.sessionUpdate, 'tool_call_update')
  assert.equal(last.toolCallId, 't1')
  assert.deepEqual(last.content, [{ type: 'terminal', terminalId: 't1' }])
})

test('PiAcpSession: keeps a standalone prompt card when no tool call is executing', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 't1', result: { content: [{ type: 'text', text: 'ok' }] } })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-9',
    method: 'select',
    title: 'Permission Required\nAllow the skill to run?',
    options: ['Yes', 'No']
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 'pi-ui-ui-9')
  // Multi-line titles render badly, so the heading stays the title and the rest becomes content.
  assert.equal(request.toolCall.title, 'Permission Required')
  assert.deepEqual(request.toolCall.content, [
    { type: 'content', content: { type: 'text', text: 'Allow the skill to run?' } }
  ])
})

test('PiAcpSession: attaches a confirm prompt to the gated tool call with its message', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'yes' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'read', args: { path: 'package.json' } })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Permission Required',
    message: "Current agent requested tool 'read' for path 'package.json'. Allow this call?"
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 't2')
  assert.equal(request.toolCall.title, 'Read package.json')
  assert.deepEqual(request.toolCall.content, [
    {
      type: 'content',
      content: {
        type: 'text',
        text: "Permission Required\n\nCurrent agent requested tool 'read' for path 'package.json'. Allow this call?"
      }
    }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: true }])
})

test('PiAcpSession: repeats long option text as wrapping content and shortens the button labels', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  const long =
    'Flip the default in pi-acp so descriptive titles are on and the env var becomes an opt-out (Recommended)'
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-3',
    method: 'select',
    title: 'How do you want descriptive tool titles enabled?',
    options: [long, 'Add the env var to my Zed settings']
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.equal(request.options[0].name, `${`1. ${long}`.slice(0, 71).trimEnd()}\u2026`)
  assert.ok(request.options[0].name.length <= 76, 'button label stays inside the panel')
  assert.equal(request.options[1].name, '2. Add the env var to my Zed settings')
  assert.deepEqual(request.toolCall.content.at(-1), {
    type: 'content',
    content: { type: 'text', text: `1. ${long}\n2. Add the env var to my Zed settings` }
  })
  // The reply still maps back by index, not by the shortened label.
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-3', value: 'Add the env var to my Zed settings' }])
})

test('PiAcpSession: does not double-number options pi already numbered', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  const first = '1. Build the titler now, env-var gated - implements PI_ACP_TITLE_MODEL and shells out to pi -p'
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-5',
    method: 'select',
    title: 'Should I build the thread titler next?',
    options: [first, '2. Type something.']
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.equal(request.options[0].name, `${first.slice(0, 71).trimEnd()}\u2026`)
  assert.equal(request.options[1].name, '2. Type something.')
  assert.deepEqual(request.toolCall.content.at(-1), {
    type: 'content',
    content: { type: 'text', text: `${first}\n2. Type something.` }
  })
})

test('PiAcpSession: leaves short option labels untouched', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  const proc = new FakePiRpcProcess()
  makeSession(proc, conn)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-4',
    method: 'select',
    title: 'Permission Required\nAllow?',
    options: ['Yes', 'No']
  })

  await settle()

  const request = conn.permissionRequests[0] as any
  assert.deepEqual(
    request.options.map((o: any) => o.name),
    ['Yes', 'No']
  )
  assert.deepEqual(request.toolCall.content, [{ type: 'content', content: { type: 'text', text: 'Allow?' } }])
})
