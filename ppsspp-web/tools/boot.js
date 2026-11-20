// End to end: import a PSP program through the page's file picker (into OPFS), boot it, screenshot.
const { chromium } = require('playwright')
const file = process.argv[2], out = process.argv[3] || 'boot.png'
;(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 544 } })
  const lines = []
  page.on('console', (m) => lines.push(m.text()))
  await page.goto('http://localhost:8080/')
  await page.waitForTimeout(800)
  await page.setInputFiles('#pick', file)
  await page.waitForFunction(() => document.querySelector('#games .name'), null, { timeout: 30000 })
  console.log('library:', await page.$$eval('#games li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')).join(' | ')))
  await page.click('#games button.primary')
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(3000)
    console.log(`t=${(i+1)*3}s main/emu/replayed:`, JSON.stringify(await page.evaluate(() => [0,1,2].map(i => Module._PPSSPPWeb_Stat(i)))))
  }
  await page.screenshot({ path: out })
  console.log(lines.filter((l) => /Boot|boot|Loading|ELF|PRX|Error|error|EmuScreen|HLE|Launching/.test(l) && !/CreateDir|mprotect/.test(l)).slice(-25).join('\n'))
  await browser.close()
})()
