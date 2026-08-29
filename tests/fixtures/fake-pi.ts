let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const command = JSON.parse(line) as { id?: string; type: string }
    if (command.type === 'ping') {
      write({ type: 'queue_update', steering: ['hello\u2028world'], followUp: [] })
      write({ type: 'response', id: command.id, command: 'ping', success: true, data: { pong: true } })
    } else if (command.type === 'argv') {
      write({ type: 'response', id: command.id, command: 'argv', success: true, data: { argv: process.argv.slice(2) } })
    } else if (command.type === 'fail') {
      write({ type: 'response', id: command.id, command: 'fail', success: false, error: 'expected failure' })
    } else {
      write({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
    }
  }
})

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
