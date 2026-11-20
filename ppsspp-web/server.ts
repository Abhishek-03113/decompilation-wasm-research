// Serves the PPSSPP WebAssembly build with Bun.
//
// PPSSPP runs on several threads, which in a browser needs SharedArrayBuffer, which browsers only
// allow on cross-origin isolated pages. So every response carries COOP and COEP headers.
// Browsers also require a secure context: http://localhost works, anything else needs HTTPS.
//
//   bun run server.ts      ->  http://localhost:8080

import { join, normalize } from 'node:path'

const port = Number(process.env.PORT) || 8080
const publicDir = join(import.meta.dir, 'public')

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// Bun infers most types from the extension; these are the ones that matter here.
const contentTypes: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

function contentType(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? contentTypes[path.slice(dot)] : undefined
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'

    // Resolve inside public/ only.
    const filePath = normalize(join(publicDir, pathname))
    if (!filePath.startsWith(publicDir)) {
      return new Response('Forbidden', { status: 403, headers: isolationHeaders })
    }

    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return new Response('Not found', { status: 404, headers: isolationHeaders })
    }

    const headers: Record<string, string> = {
      ...isolationHeaders,
      // The page and loader change with every build; the large binaries can be cached for a while.
      'Cache-Control': /\.(html|js)$/.test(filePath) ? 'no-cache' : 'public, max-age=3600',
    }
    const type = contentType(filePath)
    if (type) headers['Content-Type'] = type
    return new Response(file, { headers })
  },
})

console.log(`PPSSPP web runtime: http://localhost:${server.port}`)
