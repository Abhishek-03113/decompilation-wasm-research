// Serves the PPSSPP WebAssembly build.
//
// PPSSPP runs on several threads, which in a browser needs SharedArrayBuffer, which browsers only
// allow on cross-origin isolated pages. So every response carries COOP and COEP headers.
// Browsers also require a secure context: http://localhost works, anything else needs HTTPS.
//
//   npm install && npm start      ->  http://localhost:8080

const express = require('express')
const path = require('path')

const app = express()
const port = Number(process.env.PORT) || 8080
const publicDir = path.join(__dirname, 'public')

app.use((req, res, next) => {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
  next()
})

express.static.mime.define({ 'application/wasm': ['wasm'] })

app.use(express.static(publicDir, {
  setHeaders(res, file) {
    // The page and loader change with every build; the hashed-by-build binaries can be cached.
    if (file.endsWith('.html') || file.endsWith('.js')) {
      res.set('Cache-Control', 'no-cache')
    } else {
      res.set('Cache-Control', 'public, max-age=3600')
    }
  },
}))

app.listen(port, () => {
  console.log(`PPSSPP web runtime: http://localhost:${port}`)
})
