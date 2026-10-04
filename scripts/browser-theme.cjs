// Appearance regression checks use a local backend configuration fixture only.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const base = process.argv[2] || 'http://127.0.0.1:4177';
const output = path.resolve('test-results/theme');
const waitTheme = (page, theme) => page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
async function choose(page, mode) {
  await page.locator('#appearance-open').click();
  await page.locator(`[data-theme-choice="${mode}"]`).click();
  assert.equal(await page.locator(`[data-theme-choice="${mode}"]`).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', {name: '关闭外观设置', exact: true}).click();
}
async function readable(page, selector) {
  const ratio = await page.locator(selector).evaluate(el => {
    const style = getComputedStyle(el);
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(x => Number(x) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
  assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} is below 4.5`);
}
async function main() {
  await fs.mkdir(output, {recursive: true});
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({colorScheme: 'light', viewport: {width: 1280, height: 960}});
    await context.route('**/site-config.json', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({supabaseUrl: 'https://quiet-harbor-qa.supabase.co', supabaseAnonKey: 'sb_publishable_browser_qa_fixture'})}));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await waitTheme(page, 'light');
    await page.emulateMedia({colorScheme: 'dark'});
    await waitTheme(page, 'dark');
    await choose(page, 'light');
    await page.reload();
    await waitTheme(page, 'light');
    assert.equal(await page.evaluate(() => localStorage.getItem('qh-theme')), 'light');
    // Explicit light mode stays light even when the OS switches.
    await page.emulateMedia({colorScheme: 'light'});
    await page.emulateMedia({colorScheme: 'dark'});
    await waitTheme(page, 'light');
    for (const theme of ['light', 'dark']) {
      await choose(page, theme);
      await waitTheme(page, theme);
      await readable(page, '#chat-nav');
      await readable(page, '#send');
      await page.locator('#message').click();
      assert.equal(await page.locator('#message').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      assert.notEqual(await page.locator('.composer').evaluate(el => getComputedStyle(el).boxShadow), 'none');
      await page.screenshot({path: path.join(output, `chat-${theme}-desktop.png`), fullPage: true});
      await page.locator('#account-open').click();
      for (const name of ['登录', '申请加入']) {
        const tab = page.locator('.auth-tabs').getByRole('button', {name, exact: true});
        await tab.click();
        await readable(page, '.auth-tabs button.primary');
      }
      await page.getByRole('button', {name: '关闭账户设置', exact: true}).click();
      await page.setViewportSize({width: 390, height: 844});
      await choose(page, theme);
      const dimensions = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
      assert.ok(dimensions.scroll <= dimensions.width + 1, `${theme} mobile overflow`);
      await page.screenshot({path: path.join(output, `chat-${theme}-mobile.png`), fullPage: true});
      await page.setViewportSize({width: 1280, height: 960});
    }
    const other = await context.newPage();
    await other.goto(base);
    await choose(page, 'light');
    await waitTheme(other, 'light');
    await choose(page, 'dark');
    await waitTheme(other, 'dark');
    await other.goto(base + '/community-rules.html');
    await waitTheme(other, 'dark');
    assert.equal(await other.locator('html').evaluate(el => getComputedStyle(el).colorScheme), 'dark');
    await choose(page, 'system');
    await page.emulateMedia({colorScheme: 'light'});
    await waitTheme(page, 'light');
    await page.emulateMedia({colorScheme: 'dark'});
    await waitTheme(page, 'dark');
    assert.deepEqual(errors, []);
    await context.close();

    const blocked = await browser.newContext({colorScheme: 'dark'});
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    });
    const fallback = await blocked.newPage();
    await fallback.goto(base);
    await waitTheme(fallback, 'dark');
    await choose(fallback, 'light');
    await waitTheme(fallback, 'light');
    await blocked.close();
    console.log('Appearance checks passed: system changes, explicit preference/reload, tab sync, rules page, unavailable storage, selected/action contrast, single composer focus and mobile layouts');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
