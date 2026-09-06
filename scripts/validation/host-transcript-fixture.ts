import { startLongSessionHost } from '../../tests/helpers/long-session-host.ts'

const port = Number.parseInt(process.env.HEDDLEWORK_HOST_PORT ?? '47321', 10)
const fixture = await startLongSessionHost({
  port: Number.isFinite(port) ? port : 47321,
  hostname: process.env.HEDDLEWORK_HOST_BIND ?? '127.0.0.1',
})

console.log(`Heddlework long-session fixture ${fixture.workspacePath}`)
console.log(`  url     ${fixture.host.url}`)
console.log(`  connect ${fixture.connectUrl}`)
console.log(`  alpha   ${fixture.alphaPath}`)
console.log(`  beta    ${fixture.betaPath}`)

const shutdown = (): void => {
  void fixture.close().finally(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
