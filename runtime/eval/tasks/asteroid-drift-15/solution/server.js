import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, normalize, resolve, sep } from 'node:path'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.md': 'text/plain', '.json': 'application/json' }
const root = resolve(process.cwd())

// Only files inside the project directory are served: the canonical path of
// the request must stay under the root, so `..` segments and absolute paths
// cannot reach outside it.
function resolveInsideRoot(url) {
  const requested = decodeURIComponent(url === '/' ? '/index.html' : url.split('?')[0])
  const candidate = resolve(root, '.' + normalize('/' + requested))
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null
}

createServer(async (request, response) => {
  const path = resolveInsideRoot(request.url ?? '/')
  if (path === null) {
    response.writeHead(403)
    response.end('forbidden')
    return
  }
  try {
    const body = await readFile(path)
    response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
}).listen(8080, () => {
  console.log('Asteroid Drift on http://localhost:8080')
})
