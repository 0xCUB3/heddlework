import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const requested = args[args.indexOf('--session') + 1]
const sessionPath = args.includes('--session') && requested ? requested : join(process.cwd(), `fixture-${process.pid}.jsonl`)
let sessionId = crypto.randomUUID()
try { sessionId = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]!).id ?? sessionId } catch {}
if (!existsSync(sessionPath)) writeFileSync(sessionPath, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n')
const log = (event: string, details: object = {}) => appendFileSync(join(process.cwd(), 'agent-events.jsonl'), JSON.stringify({ event, pid: process.pid, sessionPath, ...details }) + '\n')
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const messages: unknown[] = []
const model = { provider: 'fixture', id: 'runtime', name: 'Runtime fixture', reasoning: false, contextWindow: 10000 }
let running = false
let timer: ReturnType<typeof setInterval> | undefined
let tick = 0
const callId = `tool-${process.pid}`
const append = (message: unknown) => { messages.push(message); appendFileSync(sessionPath, JSON.stringify({ type: 'message', id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString(), message }) + '\n') }
log('start')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const command = JSON.parse(line)
    if (command.type === 'extension_ui_response') { log('approval', command); continue }
    let data: unknown = {}
    switch (command.type) {
      case 'get_state': data = { model, sessionId, sessionFile: sessionPath, isStreaming: running, thinkingLevel: 'off' }; break
      case 'get_tree': data = { tree: [], leafId: null }; break
      case 'get_messages': data = { messages }; break
      case 'get_fork_messages': data = { messages: [] }; break
      case 'get_commands': data = { commands: [] }; break
      case 'get_available_models': data = { models: [model] }; break
      case 'get_available_thinking_levels': data = { levels: ['off'] }; break
      case 'get_session_stats': data = { sessionId, totalMessages: messages.length, toolCalls: 1, cost: 0 }; break
      case 'prompt': {
        if (String(command.message).startsWith('/heddlework-')) break
        log('prompt', { message: command.message })
        append({ role: 'user', content: command.message, timestamp: Date.now() })
        running = true
        write({ type: 'agent_start' })
        write({ type: 'turn_start', turnId: `turn-${process.pid}` })
        const assistant = { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'fixture-long-operation' } }], timestamp: Date.now() }
        append(assistant)
        write({ type: 'message_end', message: assistant })
        write({ type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: { command: 'fixture-long-operation' } })
        if (!timer) timer = setInterval(() => {
          tick++
          log('tick', { tick })
          write({ type: 'tool_execution_update', toolCallId: callId, toolName: 'bash', partialResult: { content: [{ type: 'text', text: `PID ${process.pid}\nprogress ${tick}` }] } })
        }, 150)
        if (String(command.message).includes('approval')) write({ type: 'extension_ui_request', id: `approval-${process.pid}`, method: 'confirm', title: 'Fixture approval', message: 'Keep this approval pending across reconnect?' })
        break
      }
      case 'abort': {
        if (timer) clearInterval(timer)
        timer = undefined
        running = false
        const result = { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text: `PID ${process.pid}\nfinished after ${tick} ticks` }], isError: false, timestamp: Date.now() }
        append(result)
        write({ type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: { content: result.content }, isError: false })
        write({ type: 'agent_end', messages })
        write({ type: 'agent_settled' })
        log('abort')
        break
      }
    }
    write({ type: 'response', id: command.id, command: command.type, success: true, data })
  }
})
process.once('SIGTERM', () => { log('stop'); process.exit(0) })
