// Boots one server game directly (?boot=) in headless Chromium, screenshots it every few seconds
// and keeps PPSSPP's console output, to see how far a game gets.
//   node tools/boot-game.js ISO/<file> [outdir] [seconds] [extra query, e.g. "&x=1"]
// (server must be running on :8080; needs Playwright)
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const game = process.argv[2], outDir = process.argv[3] || '.', seconds = +(process.argv[4] || 90)
const extra = process.argv[5] || ''

;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  const lines = []
  const t0 = Date.now()
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6)
  page.on('console', (m) => lines.push(`${stamp()} ${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => lines.push(`${stamp()} pageerror: ${e.message}`))
  await page.goto('http://localhost:8080/?boot=' + encodeURIComponent(game) + extra)
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 600000 })
  lines.push(`${stamp()} synced: ${await page.textContent('#sync-label')}`)
  await page.click('#start')
  await page.evaluate(() => { document.querySelector('#stats').hidden = false })
  for (let s = 5; s <= seconds; s += 5) {
    await page.waitForTimeout(5000)
    await page.screenshot({ path: path.join(outDir, `t${String(s).padStart(3, '0')}.png`) })
    lines.push(`${stamp()} stats: ${(await page.textContent('#stats')).replace(/\n/g, ' | ')}`)
  }
  fs.writeFileSync(path.join(outDir, 'console.log'), lines.join('\n') + '\n')
  console.log(lines.filter((l) => !/stats:/.test(l)).slice(-60).join('\n'))
  console.log(lines.filter((l) => /stats:/.test(l)).join('\n'))
  await browser.close()
})()
