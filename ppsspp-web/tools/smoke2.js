const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  const lines = []
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`))
  await page.goto('http://localhost:8080/')
  await page.waitForTimeout(800)
  await page.click('#menu')
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(3000)
    const st = await page.evaluate(() => window.Module && Module._PPSSPPWeb_Stat ? [0,1,2].map(i => Module._PPSSPPWeb_Stat(i)) : null)
    console.log(`t=${(i+1)*3}s main/emu/replayed:`, JSON.stringify(st))
  }
  await page.screenshot({ path: process.argv[2] || 'shot.png' })
  console.log(lines.filter((l) => !/mprotect|Heap resize|CreateDir/.test(l)).slice(-40).join('\n'))
  await browser.close()
})()
