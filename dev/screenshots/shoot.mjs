// Drives the web UI with sample data, checks its behavior and writes the README screenshots.
import assert from 'node:assert/strict';
import { chromium } from '/app/node_modules/playwright/index.mjs';

const [out, base = 'http://localhost:8080'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const errors = [];

for (const lang of ['en', 'de']) {
  const context = await browser.newContext({ locale: lang === 'en' ? 'en-GB' : 'de-DE', viewport: { width: 1200, height: 900 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.fill('#token', 'e2e-admin-token-1234');
  await page.click('#login button');
  await page.waitForSelector('#roles tr');
  await page.waitForSelector('.runrow');
  await page.selectOption('#preset', { label: 'Screen share + 1 camera, growing audience' }).catch(() => page.selectOption('#preset', { label: 'Screenshare + 1 Kamera, Zuhörer steigern' }));

  await page.evaluate(() => document.querySelector('#app').children[0].scrollIntoView());
  await page.locator('#app > section').first().screenshot({ path: `${out}/${lang}-scenario.png` });

  // Open run: charts, table, log and actions
  const [first] = await page.locator('.runrow details').all();
  await first.locator('summary').click();
  await page.waitForSelector('.runbody svg[data-chart]');
  await page.waitForTimeout(3500); // survives a poll: it must stay open
  assert.equal(await first.getAttribute('open'), '', 'details stay open across a refresh');
  assert.ok((await first.locator('.log').textContent()).includes('Run finished'), 'log is shown');
  assert.equal(await first.locator('figure.chart').count(), 8, 'eight charts');
  const svg = first.locator('svg[data-chart]').nth(2);
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await page.waitForTimeout(150);
  const tip = page.locator('.chart-tip:not([hidden])');
  assert.equal(await tip.count(), 1, 'tooltip visible on hover');
  console.log(lang, 'tooltip:', (await tip.textContent()).slice(0, 60));
  await first.locator('.runbody').screenshot({ path: `${out}/${lang}-run.png` });
  await page.mouse.move(0, 0);

  const [report] = await Promise.all([page.waitForEvent('download'), first.locator('.runbody .row button').first().click()]);
  console.log(lang, 'report:', report.suggestedFilename());
  await report.saveAs(`/tmp/${lang}-report.html`);

  // Self-test result
  const check = page.locator('.runrow details', { hasText: lang === 'en' ? 'Self-test' : 'Selbsttest' });
  await check.locator('summary').click();
  await check.locator('.selftest').waitFor();
  assert.equal(await check.locator('.selftest tr').count(), 8, 'eight checks');
  await check.locator('.viz-root').screenshot({ path: `${out}/${lang}-selftest.png` });
  await check.locator('summary').click();

  // Compare two runs
  await page.locator('.runrow input').nth(0).check();
  await page.locator('.runrow input').nth(1).check();
  await page.waitForTimeout(3500);
  assert.equal(await page.locator('.runrow input:checked').count(), 2, 'selection survives a poll');
  await page.click('#compareButton');
  await page.waitForSelector('#compare svg[data-chart]');
  await page.waitForTimeout(600);
  await page.locator('#compareCard').screenshot({ path: `${out}/${lang}-compare.png` });

  // Series builder
  await page.selectOption('#seriesAdd', { label: 'Demo A' });
  await page.selectOption('#seriesAdd', { label: 'Demo B' });
  assert.equal(await page.locator('#seriesList li').count(), 2, 'series list');
  await page.locator('#seriesList li').nth(1).locator('button').first().click();
  assert.ok((await page.locator('#seriesList li').first().textContent()).startsWith('Demo B'), 'reordering');
  await page.fill('#seriesName', lang === 'en' ? 'Night series' : 'Nachtserie');
  await page.locator('#app > section').nth(1).screenshot({ path: `${out}/${lang}-series.png` });

  await context.close();
}

// Delete a saved template, built-in ones stay protected
const context = await browser.newContext({ locale: 'en-GB' });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(base);
await page.fill('#token', 'e2e-admin-token-1234');
await page.click('#login button');
await page.waitForSelector('#roles tr');
await page.selectOption('#preset', { label: 'Screen share + 1 camera, growing audience' });
assert.equal(await page.isDisabled('#deleteScenario'), true, 'built-in template cannot be deleted');
await page.selectOption('#preset', { label: 'Demo B' });
await page.click('#deleteScenario');
await page.waitForFunction(() => document.querySelector('#scenarioResult').textContent === 'Deleted');
assert.equal(await page.locator('#preset option', { hasText: 'Demo B' }).count(), 0, 'template gone');

// The downloaded report works offline: open it from disk
for (const lang of ['en', 'de']) {
  const report = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'light', offline: true });
  const p = await report.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`file:///tmp/${lang}-report.html`);
  assert.equal(await p.locator('figure.chart').count(), 8, 'report has charts');
  const svg = p.locator('svg[data-chart]').nth(2);
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await p.mouse.move(box.x + box.width * 0.5, box.y + 40);
  await p.waitForTimeout(150);
  assert.equal(await p.locator('.chart-tip:not([hidden])').count(), 1, 'report tooltip');
  await p.mouse.move(0, 0);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: `${out}/${lang}-report.png`, fullPage: false });
  if (lang === 'en') {
    const dark = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark', offline: true });
    const d = await dark.newPage();
    await d.goto('file:///tmp/en-report.html');
    assert.equal(await d.locator('figure.chart').count(), 8, 'dark report has charts');
  }
}
console.log('JS errors:', JSON.stringify(errors));
assert.deepEqual(errors, []);
await browser.close();
console.log('UI checks passed');
