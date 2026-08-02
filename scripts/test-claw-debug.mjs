// Playwright 验证脚本 - 测试消息通信页面（带详细错误堆栈）
import { chromium } from 'playwright';

const BASE = 'http://localhost:4577';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    console.log(`  [console.${msg.type()}]`, msg.text());
  });
  page.on('pageerror', (err) => {
    console.log('  [pageerror]', err.message);
    console.log('  [stack]', err.stack || 'no stack');
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      console.log(`  [http ${resp.status()}] ${resp.url()}`);
    }
  });

  await page.goto(BASE + '/login.html');
  await page.waitForSelector('button[type="submit"]', { timeout: 5000 });
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/#\/overview/, { timeout: 5000 });

  await page.goto(BASE + '/#/claw');
  await page.waitForTimeout(1500);
  console.log('连接页签 qrcodeBox img:', await page.locator('#qrcodeBox img').count());

  await page.click('text=推送订阅');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/claw-push-debug.png', fullPage: true });
  console.log('push tab prTable:', await page.locator('#prTable').count());
  console.log('push tab obTable:', await page.locator('#obTable').count());

  await browser.close();
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
