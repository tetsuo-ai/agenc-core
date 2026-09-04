import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.md': 'text/plain', '.json': 'application/json' }
const root = process.cwd()

createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(request.url === '/' ? '/index.html' : request.url))
  try {
    const body = await readFile(join(root, path))
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
}).listen(8080, () => {
  console.log('Asteroid Drift on http://localhost:8080')
})
