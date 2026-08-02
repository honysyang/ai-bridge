/**
 * routes/claw.js —— 微信 Claw 路由（v7.1）
 *
 * 路由：
 *   GET    /api/claw/status             状态
 *   POST   /api/claw/login/start        触发扫码（mock 可 skip 直接连）
 *   POST   /api/claw/logout             退出
 *   POST   /api/claw/restart            重启 adapter
 *   POST   /api/claw/diagnose           连接诊断（ping 平台 / 检查凭证）
 *   GET    /api/claw/credentials        查看 iLink 凭证状态（不返回明文）
 *   POST   /api/claw/credentials        写入 iLink 凭证
 *   DELETE /api/claw/credentials        清除 iLink 凭证
 *   GET    /api/claw/contacts           联系人列表（支持 ?q=搜索&group=分组&type=）
 *   POST   /api/claw/contacts           新增联系人
 *   PUT    /api/claw/contacts/:id       更新联系人
 *   DELETE /api/claw/contacts/:id       删除联系人
 *   POST   /api/claw/contacts/seed      重新播种默认联系人
 *   GET    /api/claw/rooms              群列表
 *   POST   /api/claw/messages/:id/read 标记消息已读
 *   GET    /api/claw/messages           消息历史（支持 ?wxid= &q= &limit= &before= &after=）
 *   POST   /api/claw/send               发消息
 *   POST   /api/claw/mock/incoming      mock 模式：模拟收到微信消息
 *   POST   /api/claw/mock/connect       mock 模式：直接连接
 *   POST   /api/claw/mock/disconnect    mock 模式：断开连接
 *   GET    /api/claw/push-rules         推送规则列表
 *   POST   /api/claw/push-rules         新增推送规则
 *   PATCH  /api/claw/push-rules/:id     更新推送规则
 *   DELETE /api/claw/push-rules/:id     删除推送规则
 *   POST   /api/claw/push-rules/:id/test 测试推送规则（触发一条 outbox 并尝试发送）
 *   GET    /api/claw/outbox             推送记录
 */
import express from 'express';
import QRCode from 'qrcode';
import { clawManager } from '../claw/index.js';
import { hasIlinkCredentials, readSecrets, writeSecrets, clearSecrets } from '../claw/secrets.js';

const EVENT_BY_STATUS = { processing: 'accepted', completed: 'completed', failed: 'failed' };
const STATUS_LABEL = { accepted: '已受理', completed: '已完成', failed: '失败' };
const fired = new Set();

const DEFAULT_CONTACTS = [
  { wxid: 'filehelper', name: '文件传输助手', type: 'friend', group: '系统' },
  { wxid: 'wxid_zhangsan', name: '张三', type: 'friend', group: '同事' },
  { wxid: 'wxid_lisi', name: '李四', type: 'friend', group: '同事' },
  { wxid: 'room_product', name: '产品讨论群', type: 'room', group: '群聊' },
  { wxid: 'room_dev', name: '开发协作群', type: 'room', group: '群聊' },
];

export default function (ctx) {
  const router = express.Router();
  const { store, events, util, auth } = ctx;
  const ru = auth.requireUser;
  const isAdmin = auth.requireAdmin;
  const contacts = () => store.coll('contacts');
  const messages = () => store.coll('messages');
  const rules = () => store.coll('push_rules');
  const outbox = () => store.coll('outbox');

  const isMock = () => process.env.ILINK_MOCK === '1';
  const isConnected = () => clawManager.getStatus()?.state === 'connected' || (isMock() && store.getSetting('claw.connected', false));
  const contactName = (wxid) => contacts().find((c) => c.wxid === wxid)?.name || wxid;

  function seedContacts(force = false) {
    if (!force && contacts().count() > 0) return;
    for (const c of DEFAULT_CONTACTS) {
      if (!contacts().find((x) => x.wxid === c.wxid)) {
        contacts().insert({ id: util.uid('contact'), ...c });
      }
    }
  }

  function buildOutboxText(task, event) {
    const agentName = task.assigned_to
      ? (store.coll('agents').get(task.assigned_to)?.name || task.assigned_to)
      : '（待分配）';
    const summary = String(task.data?.content || '').slice(0, 50);
    let text = `【任务${STATUS_LABEL[event]}】${summary}\n状态：${task.status}（${STATUS_LABEL[event]}）\n执行者：${agentName}`;
    if (event === 'completed' && task.result?.summary) text += `\n结果：${String(task.result.summary).slice(0, 100)}`;
    if (event === 'failed' && task.result?.summary) text += `\n原因：${String(task.result.summary).slice(0, 100)}`;
    return text;
  }

  /* ==================== 推送引擎：task:changed → 写 outbox + 发送 ==================== */
  events.on('task:changed', (task) => {
    try {
      const event = EVENT_BY_STATUS[task?.status];
      if (!event) return;
      const dedupKey = `${task.id}:${event}`;
      if (fired.has(dedupKey)) return;
      const enabledRules = rules().all().filter((r) => {
        if (!r.enabled) return false;
        if (!Array.isArray(r.events) || !r.events.includes(event)) return false;
        if (Array.isArray(r.source_filter) && r.source_filter.length > 0 && !r.source_filter.includes(task.source)) return false;
        return true;
      });
      if (enabledRules.length === 0) return;
      fired.add(dedupKey);
      const text = buildOutboxText(task, event);
      for (const rule of enabledRules) {
        pushToContact(rule.target_wxid, text, { rule_id: rule.id, task_id: task.id, event });
      }
    } catch (e) {
      store.log('error', 'claw', `推送引擎异常: ${e.message}`);
    }
  });

  function pushToContact(wxid, text, meta = {}) {
    const item = outbox().insert({
      id: util.uid('outbox'),
      wxid,
      content: text,
      sent: false,
      sent_at: null,
      at: util.now(),
      ...meta,
    });
    messages().insert({
      id: util.uid('msg'),
      direction: 'out',
      wxid,
      content: text,
      ...meta,
      at: util.now(),
      read: true,
    });
    if (clawManager.getStatus()?.state === 'connected') {
      clawManager.sendText(wxid, text).then(() => {
        outbox().update(item.id, { sent: true, sent_at: util.now() });
      }).catch((e) => {
        store.log('warn', 'claw', `真实推送失败（${wxid}）：${e.message}`);
      });
    }
    return item;
  }

  /* ==================== 收消息：wechat 任务生成 ==================== */
  clawManager.onMessage = (msg) => {
    try {
      const wxid = msg.isRoom ? (msg.groupId || msg.sessionId) : msg.fromUser;
      const content = String(msg.text || '').trim();
      if (!content) return;
      seedContacts();
      if (!contacts().find((c) => c.wxid === wxid)) {
        contacts().insert({
          id: util.uid('contact'),
          wxid,
          name: msg.isRoom ? `群 ${wxid.slice(0, 8)}` : `用户 ${wxid.slice(0, 8)}`,
          type: msg.isRoom ? 'room' : 'friend',
          group: '未分组',
        });
      }
      messages().insert({
        id: util.uid('msg'),
        direction: 'in',
        wxid,
        content,
        msg_id: msg.msgId,
        at: util.now(),
        read: false,
      });
      const task = store.coll('tasks').insert({
        id: util.uid('task'),
        type: 'reply_message',
        priority: 'normal',
        source: 'wechat',
        data: {
          content,
          from_user: contactName(wxid),
          extra: { wxid, isRoom: msg.isRoom, msgId: msg.msgId },
        },
        status: 'pending',
        created_at: util.now(),
      });
      events.emit('task:changed', task);
      store.log('info', 'claw', `收到微信消息（${contactName(wxid)}）→ 任务 ${task.id}`);
    } catch (e) {
      store.log('error', 'claw', `收消息处理失败: ${e.message}`);
    }
  };

  /* ==================== 连接 / 状态 ==================== */
  router.get('/status', ru, (req, res) => {
    if (isMock()) {
      const connected = store.getSetting('claw.connected', false);
      const hasQr = !!store.getSetting('claw.mock_qr_token');
      return res.json({
        connected,
        mock: true,
        account: connected ? store.getSetting('claw.account', 'wxid_demo_bot') : undefined,
        adapter: 'mock',
        state: connected ? 'connected' : (hasQr ? 'qrcode' : 'disconnected'),
        qrcodeUrl: hasQr ? '/api/claw/qrcode.png' : null,
        qrcodeExpiresAt: hasQr ? (Date.now() + 180_000) : null,
        needsQrcode: !connected,
      });
    }
    const s = clawManager.getStatus();
    res.json({
      connected: s.state === 'connected',
      mock: false,
      adapter: 'ilink',
      state: s.state,
      account: s.account,
      qrcodeUrl: s.qrcodeUrl,
      qrcodeExpiresAt: s.qrcodeExpiresAt,
      needsQrcode: s.state === 'disconnected' && !hasIlinkCredentials(),
      error: s.error,
    });
  });

  router.post('/diagnose', ru, async (req, res) => {
    if (isMock()) {
      return res.json({
        mock: true,
        ok: true,
        checks: [
          { name: 'mock 模式', ok: true, detail: '演示环境，不连接真实微信' },
          { name: '数据存储', ok: true, detail: 'contacts / messages / outbox / push_rules 正常' },
          { name: '推送引擎', ok: true, detail: '已监听 task:changed' },
        ],
      });
    }
    const checks = [];
    const secrets = readSecrets();
    checks.push({ name: 'iLink 凭证', ok: hasIlinkCredentials(), detail: hasIlinkCredentials() ? '已配置' : '未配置 ILINK_BOT_TOKEN 等' });
    checks.push({ name: 'iLink BASE_URL', ok: !!secrets.ILINK_BASE_URL, detail: secrets.ILINK_BASE_URL || '使用默认 https://ilinkai.weixin.qq.com' });
    checks.push({ name: 'Adapter 状态', ok: clawManager.getStatus()?.state !== 'disconnected', detail: clawManager.getStatus()?.state });
    let networkOk = false;
    try {
      // 简单 ping：get_bot_qrcode 不传参数会返回错误，但能证明网络可达
      const url = new URL('ilink/bot/get_bot_qrcode', secrets.ILINK_BASE_URL.endsWith('/') ? secrets.ILINK_BASE_URL : `${secrets.ILINK_BASE_URL}/`);
      const r = await fetch(url, { method: 'GET', headers: { 'X-Token': secrets.ILINK_BOT_TOKEN || '' }, signal: AbortSignal.timeout(5000) });
      networkOk = r.ok || r.status === 400 || r.status === 401 || r.status === 403;
      checks.push({ name: '平台网络', ok: networkOk, detail: `HTTP ${r.status}` });
    } catch (e) {
      checks.push({ name: '平台网络', ok: false, detail: e.message });
    }
    res.json({ mock: false, ok: checks.every((c) => c.ok), checks });
  });

  /** 二维码图片（PNG 240x240，扫码时由前端轮询 GET 此端点） */
  router.get('/qrcode.png', ru, async (req, res) => {
    let url = null;
    if (isMock()) {
      const token = store.getSetting('claw.mock_qr_token') || `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      store.setSetting('claw.mock_qr_token', token);
      const base = `${req.protocol}://${req.get('host')}`;
      url = `${base}/api/claw/qrcode-scan?token=${encodeURIComponent(token)}`;
    } else {
      const s = clawManager.getStatus();
      url = s.qrcodeUrl || (s.qrcode ? `https://ilinkai.weixin.qq.com/scan?qrcode=${encodeURIComponent(s.qrcode)}` : null);
    }
    if (!url) return res.status(404).send('no qrcode');
    try {
      const png = await QRCode.toBuffer(url, { type: 'png', width: 240, margin: 1 });
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'no-store');
      res.send(png);
    } catch (e) {
      res.status(500).send(`qrcode render failed: ${e.message}`);
    }
  });

  /** 演示扫码回调：访问此 URL 即视为「已扫码确认」 */
  router.get('/qrcode-scan', (req, res) => {
    if (!isMock()) return res.status(404).send('not in mock mode');
    const token = String(req.query.token || '');
    const expected = store.getSetting('claw.mock_qr_token');
    if (!token || token !== expected) return res.status(400).send('invalid or expired token');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>微信扫码（演示）</title>
<style>body{font-family:-apple-system,sans-serif;background:#faf8f5;color:#4a4540;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e8e2d8;border-radius:12px;padding:40px 36px;box-shadow:0 4px 14px rgba(0,0,0,0.05);max-width:420px;text-align:center}
h2{color:#b45309;margin:0 0 12px}.ok{font-size:64px;margin:18px 0}p{line-height:1.7;color:#5a544e;font-size:14px}</style></head>
<body><div class="box">
<div class="ok">✅</div>
<h2>扫码成功（演示）</h2>
<p>这是 <b>mock 模式</b> 的演示二维码扫描结果。<br>实际生产环境会调用微信 iLink 协议，<br>完成真实扫码后将自动建立长连接。</p>
<p style="color:#8c8478;font-size:12px;margin-top:18px">本窗口可关闭，平台页面将在数秒内更新状态。</p>
</div></body></html>`);
    setTimeout(() => {
      store.setSetting('claw.connected', true);
      store.setSetting('claw.account', store.getSetting('claw.account', 'wxid_demo_user'));
      store.log('info', 'claw', 'mock：演示扫码确认，已建立连接');
    }, 2000);
  });

  router.post('/login/start', ru, async (req, res) => {
    if (isMock()) {
      if (req.body?.skip === 1 || req.body?.skip === true) {
        store.setSetting('claw.connected', true);
        store.setSetting('claw.account', req.body?.account || 'wxid_demo_user');
        store.setSetting('claw.mock_qr_token', null);
        store.log('info', 'claw', 'mock：跳过扫码直接建立连接');
        return res.json({ ok: true, connected: true, account: store.getSetting('claw.account'), mode: 'mock' });
      }
      const token = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      store.setSetting('claw.mock_qr_token', token);
      store.setSetting('claw.connected', false);
      store.log('info', 'claw', 'mock：已生成演示二维码，等待扫码');
      return res.json({ ok: true, connected: false, mode: 'mock', qrcode: token, qrcodeUrl: '/api/claw/qrcode.png' });
    }
    try {
      const status = await clawManager.startQrcode(ctx);
      res.json({ ok: true, mode: 'ilink', ...status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/logout', ru, async (req, res) => {
    if (isMock()) {
      store.setSetting('claw.connected', false);
      store.setSetting('claw.mock_qr_token', null);
      return res.json({ ok: true, connected: false });
    }
    try { await clawManager.adapter?.logout(); } catch { /* ignore */ }
    res.json({ ok: true, connected: false });
  });

  router.post('/restart', ru, async (req, res) => {
    try { await clawManager.startIlink(ctx); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ==================== 凭证管理（仅管理员）==================== */
  router.get('/credentials', ru, isAdmin, (req, res) => {
    const s = readSecrets();
    res.json({
      ILINK_BASE_URL: s.ILINK_BASE_URL || '',
      ILINK_BOT_ID: s.ILINK_BOT_ID || '',
      ILINK_USER_ID: s.ILINK_USER_ID || '',
      has_token: !!s.ILINK_BOT_TOKEN,
      has_get_updates_buf: !!s.ILINK_GET_UPDATES_BUF,
      ILINK_APP_ID: s.ILINK_APP_ID || '',
    });
  });

  router.post('/credentials', ru, isAdmin, (req, res) => {
    const { ILINK_BASE_URL, ILINK_BOT_TOKEN, ILINK_BOT_ID, ILINK_USER_ID, ILINK_APP_ID } = req.body || {};
    if (!ILINK_BOT_TOKEN || !ILINK_BOT_ID || !ILINK_USER_ID) {
      return res.status(400).json({ error: '必填：ILINK_BOT_TOKEN / ILINK_BOT_ID / ILINK_USER_ID' });
    }
    writeSecrets({
      ILINK_BASE_URL: ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com',
      ILINK_BOT_TOKEN,
      ILINK_BOT_ID,
      ILINK_USER_ID,
      ILINK_APP_ID: ILINK_APP_ID || '',
    });
    store.log('info', 'claw', '管理员写入 iLink 凭证');
    clawManager.startIlink(ctx).catch((e) => store.log('error', 'claw', `adapter 启动失败: ${e.message}`));
    res.json({ ok: true });
  });

  router.delete('/credentials', ru, isAdmin, (req, res) => {
    clearSecrets('ILINK_BOT_TOKEN', 'ILINK_BOT_ID', 'ILINK_USER_ID', 'ILINK_BASE_URL', 'ILINK_GET_UPDATES_BUF', 'ILINK_APP_ID');
    store.log('info', 'claw', '管理员清除 iLink 凭证');
    clawManager.stop().catch(() => {});
    res.json({ ok: true });
  });

  /* ==================== 联系人 ==================== */
  router.get('/contacts', ru, (req, res) => {
    seedContacts();
    let list = contacts().all();
    if (req.query.type) list = list.filter((c) => c.type === req.query.type);
    if (req.query.group) list = list.filter((c) => c.group === req.query.group);
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.wxid.toLowerCase().includes(q));
    }
    res.json(list);
  });

  router.get('/rooms', ru, (req, res) => {
    seedContacts();
    let list = contacts().all().filter((c) => c.type === 'room');
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.wxid.toLowerCase().includes(q));
    }
    res.json(list);
  });

  router.get('/contacts/groups', ru, (req, res) => {
    seedContacts();
    const groups = new Map();
    for (const c of contacts().all()) {
      const g = c.group || '未分组';
      if (!groups.has(g)) groups.set(g, { name: g, count: 0 });
      groups.get(g).count += 1;
    }
    res.json(Array.from(groups.values()));
  });

  router.post('/contacts', ru, (req, res) => {
    const { wxid, name, type = 'friend', group = '未分组', remark = '' } = req.body || {};
    if (!wxid || !name) return res.status(400).json({ error: 'wxid and name required' });
    if (contacts().find((c) => c.wxid === wxid)) return res.status(409).json({ error: 'wxid already exists' });
    const c = contacts().insert({ id: util.uid('contact'), wxid: String(wxid), name: String(name), type, group, remark });
    res.status(201).json(c);
  });

  router.put('/contacts/:id', ru, (req, res) => {
    const c = contacts().get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name);
    if (req.body.group !== undefined) patch.group = String(req.body.group);
    if (req.body.remark !== undefined) patch.remark = String(req.body.remark);
    if (req.body.type !== undefined) patch.type = req.body.type;
    res.json(contacts().update(c.id, patch));
  });

  router.delete('/contacts/:id', ru, (req, res) => {
    const c = contacts().get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    contacts().remove(c.id);
    res.json({ ok: true });
  });

  router.post('/contacts/seed', ru, (req, res) => {
    seedContacts(true);
    res.json({ ok: true, count: contacts().count() });
  });

  /* ==================== 消息 ==================== */
  router.get('/messages', ru, (req, res) => {
    let list = messages().all().sort((a, b) => a.at - b.at);
    if (req.query.wxid) list = list.filter((m) => m.wxid === req.query.wxid);
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      list = list.filter((m) => String(m.content).toLowerCase().includes(q));
    }
    if (req.query.after) list = list.filter((m) => m.at >= Number(req.query.after));
    if (req.query.before) list = list.filter((m) => m.at <= Number(req.query.before));
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(list.slice(-limit));
  });

  router.get('/messages/unread', ru, (req, res) => {
    res.json(messages().all().filter((m) => m.direction === 'in' && !m.read));
  });

  router.post('/messages/:id/read', ru, (req, res) => {
    const m = messages().get(req.params.id);
    if (!m) return res.status(404).json({ error: 'not_found' });
    res.json(messages().update(m.id, { read: true }));
  });

  router.post('/send', ru, async (req, res) => {
    const { wxid, content } = req.body || {};
    if (!wxid || !content) return res.status(400).json({ error: 'wxid and content required' });
    const isMockMode = isMock();
    if (!isMockMode && clawManager.getStatus()?.state !== 'connected') {
      return res.status(400).json({ error: 'not_connected' });
    }
    const msg = messages().insert({
      id: util.uid('msg'),
      direction: 'out',
      wxid,
      content: String(content),
      at: util.now(),
      read: true,
    });
    if (!isMockMode) {
      try { await clawManager.sendText(wxid, String(content)); }
      catch (e) { return res.status(502).json({ error: 'send_failed', detail: e.message, msg_id: msg.id }); }
    }
    res.status(201).json(msg);
  });

  /** mock 模式：模拟收到微信消息 → 生成 wechat 任务 */
  router.post('/mock/incoming', ru, (req, res) => {
    if (!isMock()) return res.status(400).json({ error: 'mock_disabled' });
    const { wxid, content } = req.body || {};
    if (!wxid || !content) return res.status(400).json({ error: 'wxid and content required' });
    seedContacts();
    const task = store.coll('tasks').insert({
      id: util.uid('task'),
      type: 'reply_message',
      priority: 'normal',
      source: 'wechat',
      data: {
        content: String(content),
        from_user: contactName(wxid),
        extra: { wxid },
      },
      status: 'pending',
      created_at: util.now(),
    });
    messages().insert({
      id: util.uid('msg'),
      direction: 'in',
      wxid,
      content: String(content),
      task_id: task.id,
      at: util.now(),
      read: false,
    });
    events.emit('task:changed', task);
    store.log('info', 'claw', `mock：收到微信消息（${contactName(wxid)}）→ 任务 ${task.id}`);
    res.status(201).json({ task });
  });

  router.post('/mock/connect', ru, (req, res) => {
    if (!isMock()) return res.status(400).json({ error: 'mock_disabled' });
    store.setSetting('claw.connected', true);
    store.setSetting('claw.account', req.body?.account || 'wxid_demo_user');
    store.log('info', 'claw', `mock：手动建立连接（${store.getSetting('claw.account')}）`);
    res.json({ ok: true, connected: true, account: store.getSetting('claw.account') });
  });

  router.post('/mock/disconnect', ru, (req, res) => {
    if (!isMock()) return res.status(400).json({ error: 'mock_disabled' });
    store.setSetting('claw.connected', false);
    store.setSetting('claw.mock_qr_token', null);
    res.json({ ok: true, connected: false });
  });

  /* ==================== 推送规则 CRUD ==================== */
  router.get('/push-rules', ru, (req, res) => res.json(rules().all()));
  router.post('/push-rules', ru, (req, res) => {
    const { name, events: evts, target_wxid } = req.body || {};
    if (!name || !target_wxid) return res.status(400).json({ error: 'name and target_wxid required' });
    if (!Array.isArray(evts) || !evts.length || !evts.every((e) => ['accepted', 'completed', 'failed'].includes(e))) {
      return res.status(400).json({ error: 'events must be non-empty subset of accepted/completed/failed' });
    }
    const rule = rules().insert({
      id: util.uid('rule'),
      name: String(name),
      events: evts,
      source_filter: Array.isArray(req.body.source_filter) ? req.body.source_filter : [],
      target_wxid: String(target_wxid),
      enabled: req.body.enabled !== false,
    });
    res.status(201).json(rule);
  });
  router.patch('/push-rules/:id', ru, (req, res) => {
    const rule = rules().get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name);
    if (req.body?.events !== undefined) {
      if (!Array.isArray(req.body.events) || !req.body.events.every((e) => ['accepted', 'completed', 'failed'].includes(e))) {
        return res.status(400).json({ error: 'invalid events' });
      }
      patch.events = req.body.events;
    }
    if (req.body?.source_filter !== undefined) patch.source_filter = Array.isArray(req.body.source_filter) ? req.body.source_filter : [];
    if (req.body?.target_wxid !== undefined) patch.target_wxid = String(req.body.target_wxid);
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
    res.json(rules().update(rule.id, patch));
  });
  router.delete('/push-rules/:id', ru, (req, res) => {
    const rule = rules().get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    rules().remove(rule.id);
    res.json({ ok: true });
  });
  router.post('/push-rules/:id/test', ru, (req, res) => {
    const rule = rules().get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    const text = `【测试推送】这是一条来自规则「${rule.name}」的测试消息，用于验证推送通道是否可用。`;
    const item = pushToContact(rule.target_wxid, text, { rule_id: rule.id, event: 'test' });
    res.status(201).json({ ok: true, outbox_id: item.id });
  });

  /* ==================== outbox ==================== */
  router.get('/outbox', ru, (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const list = outbox().all().sort((a, b) => b.at - a.at).slice(0, limit);
    res.json(list);
  });

  return router;
}
