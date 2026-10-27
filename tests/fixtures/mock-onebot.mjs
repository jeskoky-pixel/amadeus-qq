import http from 'node:http'
import { WebSocketServer } from 'ws'

const httpPort = Number(process.env.MOCK_ONEBOT_HTTP_PORT ?? 31300)
const wsPort = Number(process.env.MOCK_ONEBOT_WS_PORT ?? 31301)
const calls = []
let nextId = 90000

const ws = new WebSocketServer({ host: '127.0.0.1', port: wsPort })
const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
  catch { response.writeHead(400).end(); return }
  const action = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
  let data
  if (action === '__emit') {
    for (const client of ws.clients) if (client.readyState === client.OPEN) client.send(JSON.stringify(body))
    data = { clients: ws.clients.size }
  } else if (action === '__calls') {
    data = calls
  } else if (action === '__clear') {
    calls.length = 0
    data = {}
  } else {
    calls.push({ action, body })
    if (action === 'get_status') data = { online: true, good: true }
    else if (action === 'get_version_info') data = { app_name: 'MockOneBot', app_version: '1', protocol_version: 'v11' }
    else if (action === 'send_group_msg' || action === 'send_private_msg') data = { message_id: ++nextId }
    else if (action === 'get_friend_list') data = Array.from({ length: 125 }, (_, i) => ({ user_id: 31000 + i, nickname: `Synthetic friend ${i}` }))
    else if (action === 'get_group_list') data = Array.from({ length: 125 }, (_, i) => ({ group_id: 21000 + i, group_name: `Synthetic group ${i}` }))
    else if (action === 'get_msg') data = { message_id: body.message_id,
      raw_message: '[CQ:image,file=raw-secret-mock]',
      message: [{ type: 'text', data: { text: 'synthetic message' } },
        { type: 'image', data: { file: 'https://media.invalid/photo?token=media-secret-mock', url: 'https://media.invalid/photo?token=media-secret-mock' } }] }
    else data = {}
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', retcode: 0, data }))
})
server.listen(httpPort, '127.0.0.1', () => process.stdout.write(`MOCK_ONEBOT_READY http=${httpPort} ws=${wsPort}\n`))
const shutdown = () => { ws.close(); server.close() }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
