import { expect, test } from 'bun:test'
import { parseDevHosts } from '../scripts/deploy-dev.ts'

test('dev hosts accept and deduplicate SSH aliases', () => {
  expect(parseDevHosts(['mbp2', 'mbp2', 'build-mac.local'])).toEqual(['mbp2', 'build-mac.local'])
  expect(parseDevHosts([])).toEqual([])
})
test('dev hosts reject shell syntax and SSH options', () => {
  for (const value of [null, {}, ['-oProxyCommand=x'], ['mbp2;true'], ['$(whoami)'], ['host name'], [3]]) {
    expect(() => parseDevHosts(value)).toThrow()
  }
})
