import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolTitle } from '../../src/acp/session.js'

test('toToolTitle humanizes unknown/custom tool names', () => {
  assert.equal(toToolTitle('some-mcp-tool', {}, '/cwd'), 'Some Mcp Tool')
  assert.equal(toToolTitle('lookup', {}, '/cwd'), 'Lookup')
})

test('toToolTitle shows the URL for web_fetch', () => {
  assert.equal(toToolTitle('web_fetch', { url: 'https://example.com' }, '/cwd'), 'Fetch https://example.com')
  assert.equal(toToolTitle('web_fetch', {}, '/cwd'), 'Fetch')
})
