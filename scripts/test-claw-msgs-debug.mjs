// Playwright 验证脚本 - 调试消息记录
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

  await page.goto(BASE + '/login.html');
  await page.waitForSelector('button[type="submit"]', { timeout: 5000 });
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/#\/overview/, { timeout: 5000 });

  await page.goto(BASE + '/#/claw');
  await page.waitForTimeout(1000);

  // 先发送一条模拟消息
  await page.fill('#mockContent', '测试消息记录调试');
  await page.click('#mockSend');
  await page.waitForTimeout(1000);

  // 切到消息记录
  await page.click('text=消息记录');
  await page.waitForTimeout(500);
  const refreshBtn = page.locator('#msgRefresh');
  console.log('refresh button count:', await refreshBtn.count());
  if (await refreshBtn.count() > 0) await refreshBtn.click();
  await page.waitForTimeout(800);

  const html = await page.locator('#msgBody').innerHTML();
  console.log('msgBody HTML:', html.slice(0, 500));
  console.log('msgBody text:', await page.locator('#msgBody').textContent());
  console.log('msgBody table rows:', await page.locator('#msgBody table tbody tr').count());
  console.log('msgBody div count:', await page.locator('#msgBody div').count());

  await page.screenshot({ path: '/tmp/claw-msgs-debug.png', fullPage: true });

  await browser.close();
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
