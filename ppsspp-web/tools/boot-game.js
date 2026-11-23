// Boots one server game directly (?boot=) in headless Chromium, presses keys on a schedule and saves
// a screenshot plus the stats overlay every 5 s, and the console log, to see how far a game gets.
//   node tools/boot-game.js ISO/<file> [outdir] [seconds] [keys as [[second, key], ...]]
// (server must be running on :8080; needs Playwright)
const { chromium } = require('playwright')
const fs = require('node:fs')
const [game, outDir, seconds, plan] = [process.argv[2], process.argv[3] || '.', +(process.argv[4] || 90), JSON.parse(process.argv[5] || '[]')]
;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  const lines = []; const t0 = Date.now(); const st = () => ((Date.now() - t0) / 1000).toFixed(1)
  page.on('console', (m) => lines.push(`${st()} ${m.text()}`))
  await page.goto('http://localhost:8080/?boot=' + encodeURIComponent(game))
  await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 600000 })
  // A white page behind the canvas: a canvas that is transparent (alpha 0) then shows up white
  // instead of looking right on black, as it did before the opaque-canvas fix.
  await page.addStyleTag({ content: '#stage { background: #fff !important }' })
  await page.click('#start'); const g0 = Date.now(); await page.evaluate(() => { document.querySelector('#stats').hidden = false })
  const todo = plan.slice()
  for (let s = 0; s <= seconds; s++) {
    const now = (Date.now() - g0) / 1000
    while (todo.length && todo[0][0] <= now) { const [, k] = todo.shift(); await page.keyboard.down(k); await page.waitForTimeout(120); await page.keyboard.up(k); lines.push(`${st()} PRESS ${k}`) }
    if (s % 5 === 0) {
      lines.push(st() + ' STATS ' + (await page.textContent('#stats')).replace(/\n/g, ' | '))
      await page.screenshot({ path: `${outDir}/t${String(s).padStart(3, '0')}.png` })
    }
    await page.waitForTimeout(Math.max(0, g0 + (s + 1) * 1000 - Date.now()))
  }
  fs.writeFileSync(outDir + '/console.log', lines.join('\n') + '\n')
  console.log(lines.filter((l) => /STATS|PRESS|stopped|Abort/.test(l)).join('\n'))
  await browser.close()
})()
