// End-to-end check of server-provided games:
//   1. first visit downloads the server's memstick (ISO/, PSP/GAME/) and Start boots to the game list,
//   2. a second visit downloads nothing,
//   3. after the server removes one file and changes another, the next visit prunes and re-downloads.
//   bun tools/server-sync.js <memstick-dir> [outdir]     (server must be running on :8080)
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const memstick = process.argv[2], outDir = process.argv[3] || '.'

async function visit(context, label, { start = false } = {}) {
  const page = await context.newPage({ viewport: { width: 960, height: 544 } })
  await page.setViewportSize({ width: 960, height: 544 })
  await page.goto('http://localhost:8080/?menu')
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 60000 })
  const status = await page.textContent('#sync-label')
  const logText = await page.textContent('#log')
  console.log(`[${label}] ${status}`)
  for (const l of logText.split('\n').filter((l) => /Downloaded|Removed/.test(l))) console.log(`[${label}]   ${l}`)
  if (start) {
    await page.click('#start')
    await page.waitForTimeout(9000)
    await page.screenshot({ path: path.join(outDir, `server-${label}.png`) })
  }
  await page.close()
}

;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const context = await browser.newContext()
  await visit(context, 'first', { start: true })
  await visit(context, 'second')
  // Server side changes: remove the homebrew, change the ISO's modification time.
  fs.rmSync(path.join(memstick, 'PSP/GAME/controller'), { recursive: true })
  const iso = path.join(memstick, 'ISO/cube.iso')
  const t = new Date(Date.now() + 60000)
  fs.utimesSync(iso, t, t)
  await visit(context, 'third')
  await browser.close()
})()
