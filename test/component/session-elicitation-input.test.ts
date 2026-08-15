import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): void {
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: input UI request creates an elicitation and returns the accepted value', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationResponse = { action: 'accept', content: { value: 'my custom answer' } }
  makeSession(conn, proc)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'input',
    title: 'Your answer',
    placeholder: 'Type...'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req = conn.elicitationRequests[0] as any
  assert.equal(req.message, 'Your answer')
  assert.equal(req.mode, 'form')
  assert.equal(req.sessionId, 's1')
  assert.equal(req.requestedSchema.type, 'object')
  assert.equal(req.requestedSchema.properties.value.type, 'string')
  assert.equal(req.requestedSchema.properties.value.title, 'Answer')
  // A placeholder is a hint, not the field's label.
  assert.equal(req.requestedSchema.properties.value.description, 'Type...')
  // A schema title would be rendered above the form, repeating `message`.
  assert.equal(req.requestedSchema.title, undefined)
  assert.deepEqual(req.requestedSchema.required, ['value'])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'my custom answer' }])
})

test('PiAcpSession: input UI request with declined elicitation is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationResponse = { action: 'decline' }
  makeSession(conn, proc)

  proc.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Your answer' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
})

test('PiAcpSession: repeats the offered options when a question falls back to free text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-2' } }
  conn.elicitationResponse = { action: 'accept', content: { value: 'something else' } }
  makeSession(conn, proc)

  // How @juicesharp/rpiv-ask-user-question walks a question over pi's RPC dialogs: a select,
  // then an input when the "type your own answer" sentinel is picked. Both dialogs open with
  // the same question line.
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '[Deploy] Which environment?',
    options: ['1. staging — safe', '2. prod — careful', '3. Type something.']
  })
  await new Promise(r => setTimeout(r, 0))
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'input',
    title: '[Deploy] Which environment?\n\nType your answer:',
    placeholder: ''
  })
  await new Promise(r => setTimeout(r, 0))

  const req = conn.elicitationRequests[0] as any
  assert.equal(
    req.message,
    '[Deploy] Which environment?\n\nType your answer:\n\nOptions offered:\n1. staging — safe\n2. prod — careful\n3. Type something.'
  )
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-1', value: '3. Type something.' },
    { id: 'ui-2', value: 'something else' }
  ])
})

test('PiAcpSession: does not attach options from an unrelated earlier question', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }
  makeSession(conn, proc)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '[One] First question?',
    options: ['1. a — a', '2. Type something.']
  })
  await new Promise(r => setTimeout(r, 0))
  // A multi-select question renders as a bare input, with its own list already inlined.
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'input',
    title: '[Two] Second question?\n\n1. x — x\n2. y — y\n\nEnter the numbers of all that apply',
    placeholder: '1,3'
  })
  await new Promise(r => setTimeout(r, 0))

  const req = conn.elicitationRequests[0] as any
  assert.equal(req.message, '[Two] Second question?\n\n1. x — x\n2. y — y\n\nEnter the numbers of all that apply')
})

test('PiAcpSession: input UI request with a failing elicitation is cancelled and explained', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationError = new Error('boom')
  makeSession(conn, proc)

  proc.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Your answer' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
  // Silently dropping it leaves the user wondering why pi stopped asking.
  const text = (conn.updates.at(-1)!.update as any).content.text
  assert.match(text, /does not support ACP elicitation/)
  assert.match(text, /Your answer/)
})

test('PiAcpSession: declined elicitation is cancelled without an explanation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationResponse = { action: 'decline' }
  makeSession(conn, proc)

  proc.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Your answer' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
  assert.equal(conn.updates.length, 0)
})

test('PiAcpSession: editor UI request passes prefill as the schema default', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  makeSession(conn, proc)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'editor',
    title: 'Edit text',
    prefill: 'hello'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req = conn.elicitationRequests[0] as any
  assert.equal(req.requestedSchema.properties.value.type, 'string')
  assert.equal(req.requestedSchema.properties.value.title, 'Answer')
  assert.equal(req.requestedSchema.properties.value.default, 'hello')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', value: 'my answer' }])
})
