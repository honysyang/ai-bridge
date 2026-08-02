// Playwright 验证脚本 - 测试消息通信页面完整功能
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
    if (msg.type() === 'error') console.log('  [console.error]', msg.text());
  });
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  // 登录
  console.log('1. 登录 ...');
  await page.goto(BASE + '/login.html');
  await page.waitForSelector('button[type="submit"]', { timeout: 5000 });
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/#\/overview/, { timeout: 5000 });
  console.log('   登录成功');

  // 消息通信 - 连接页
  console.log('2. 连接页 ...');
  await page.goto(BASE + '/#/claw');
  await page.waitForSelector('#tabBody', { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claw-conn.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-conn.png');

  // 点击连接诊断
  await page.click('#btnDiagnose');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-diagnose.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-diagnose.png');

  // 点击生成演示二维码
  await page.click('#btnLogin');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/claw-qr.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-qr.png');

  // 模拟收到消息
  await page.fill('#mockContent', '帮我查一下昨天的任务成功率');
  await page.click('#mockSend');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claw-mock.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-mock.png');

  // 联系人页
  console.log('3. 联系人页 ...');
  await page.click('text=联系人');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claw-contacts.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-contacts.png');

  // 联系人搜索
  await page.fill('#cSearch', '张三');
  await page.click('#cSearchBtn');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-contacts-search.png', fullPage: true });
  console.log('   ✓ 搜索后截图 /tmp/claw-contacts-search.png');

  // 新增联系人
  await page.click('#cAdd');
  await page.waitForTimeout(300);
  await page.fill('.modal-body #cWxid', 'wxid_new_test');
  await page.fill('.modal-body #cName', '测试新人');
  await page.fill('.modal-body #cGroup', '测试分组');
  await page.click('.modal-foot .btn-ok');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-contacts-added.png', fullPage: true });
  console.log('   ✓ 新增后截图 /tmp/claw-contacts-added.png');

  // 推送订阅页
  console.log('4. 推送订阅页 ...');
  await page.click('text=推送订阅');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claw-push.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-push.png');

  // 新建规则
  await page.click('#prNew');
  await page.waitForTimeout(300);
  await page.fill('#prName', '任务失败通知');
  await page.click('[data-ev="failed"]');
  await page.click('.modal-foot .btn-ok');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-push-rule.png', fullPage: true });
  console.log('   ✓ 规则截图 /tmp/claw-push-rule.png');

  // 测试推送
  await page.click('[data-act="test"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-push-test.png', fullPage: true });
  console.log('   ✓ 测试推送截图 /tmp/claw-push-test.png');

  // 消息记录页
  console.log('5. 消息记录页 ...');
  await page.click('text=消息记录');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/claw-msgs.png', fullPage: true });
  console.log('   ✓ 截图 /tmp/claw-msgs.png');

  // 消息筛选
  await page.selectOption('#msgWxid', 'wxid_zhangsan');
  await page.click('#msgFilter');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claw-msgs-filter.png', fullPage: true });
  console.log('   ✓ 筛选后截图 /tmp/claw-msgs-filter.png');

  // 移动端视图
  console.log('6. 移动端视图 ...');
  await page.setViewportSize({ width: 414, height: 800 });
  await page.waitForTimeout(500);
  await page.click('#hamburger');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claw-mobile.png', fullPage: true });
  console.log('   ✓ 移动端截图 /tmp/claw-mobile.png');

  await browser.close();
  console.log('\n=== 测试完成 ===');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
