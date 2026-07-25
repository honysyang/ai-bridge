// ======== v5.2.0 微信 Claw 模块 ========
//
// 微信连接状态管理、二维码弹窗、登录/退出/重启。

(function (global) {
  'use strict';

  const { state, api, escapeHtml, showNotification } = global.Core;

  async function loadClawStatus() {
    try {
      const { data } = await api('/api/claw/status');
      state.claw.status = data;
      renderClawStatus();
    } catch (e) {
      console.error('loadClawStatus:', e);
      showNotification(`❌ 微信状态加载失败: ${e.message}`, 'error', 3000);
    }
  }

  function renderClawStatus() {
    const badge = document.getElementById('wechat-status');
    if (!badge) return;
    const status = state.claw.status;
    if (!status) {
      badge.setAttribute('data-state', 'disconnected');
      const textEl = badge.querySelector('.ws-text');
      if (textEl) textEl.textContent = '微信加载中';
      return;
    }

    badge.setAttribute('data-state', status.state);
    const textEl = badge.querySelector('.ws-text');
    if (!textEl) return;
    switch (status.state) {
      case 'disconnected':
        textEl.textContent = '微信未连接';
        break;
      case 'qrcode':
        textEl.textContent = '等待扫码';
        break;
      case 'connecting':
        textEl.textContent = '连接中…';
        break;
      case 'connected':
        textEl.textContent = status.nickname || status.wxid || '已连接';
        break;
      case 'reconnecting':
        textEl.textContent = '重新连接…';
        break;
      case 'banned':
        textEl.textContent = '⚠️ 封号';
        break;
      case 'error':
        textEl.textContent = '⚠️ 异常';
        break;
      default:
        textEl.textContent = status.state;
    }
  }

  async function openWechatModal() {
    state.claw.modalOpen = true;
    const modal = document.getElementById('wechat-modal');
    if (modal) modal.hidden = false;
    await loadClawStatus();
    renderWechatModal();
    // v5.2.1: 启动状态轮询，状态变化时自动重渲染面板
    startClawStatusPolling();
  }

  function closeWechatModal() {
    state.claw.modalOpen = false;
    const modal = document.getElementById('wechat-modal');
    if (modal) modal.hidden = true;
    if (state.claw.qrcodeTimer) {
      clearInterval(state.claw.qrcodeTimer);
      state.claw.qrcodeTimer = null;
    }
    stopClawStatusPolling();
  }

  // ===== v5.2.1: 动态状态轮询 =====
  // 微信扫码后状态会从 qrcode → connecting → connected，
  // 前端必须持续拉取 /api/claw/status 才能及时反映状态变化。
  function startClawStatusPolling() {
    stopClawStatusPolling();
    if (state.claw.pollingTimer) return;
    const lastState = state.claw.lastPolledState;
    state.claw.lastPolledState = state.claw.status?.state || null;
    state.claw.pollingTimer = setInterval(async () => {
      if (!state.claw.modalOpen) {
        stopClawStatusPolling();
        return;
      }
      try {
        const { data } = await api('/api/claw/status');
        const prev = state.claw.status;
        state.claw.status = data;
        // 状态变化或 qrcode_url 变化时，重新渲染面板
        if (!prev || prev.state !== data.state || (data.state === 'qrcode' && prev.qrcode_url !== data.qrcode_url)) {
          renderClawStatus();
          renderWechatModal();
          // 状态变成已连接时，给个提示
          if (data.state === 'connected' && (!prev || prev.state !== 'connected')) {
            showNotification('✅ 微信已连接', 'success', 3000);
          }
          if (data.state === 'banned' && (!prev || prev.state !== 'banned')) {
            showNotification('❌ 微信账号被封', 'error', 5000);
          }
        }
      } catch (e) {
        // 静默：避免后台噪音
        console.warn('[claw] 状态轮询失败:', e.message);
      }
    }, 2000);
  }

  function stopClawStatusPolling() {
    if (state.claw.pollingTimer) {
      clearInterval(state.claw.pollingTimer);
      state.claw.pollingTimer = null;
    }
  }

  function renderWechatModal() {
    const body = document.getElementById('wechat-modal-body');
    const footer = document.getElementById('wechat-modal-footer');
    const status = state.claw.status;
    if (!body || !footer) return;
    if (!status) {
      body.innerHTML =
        '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">加载中...</div></div>';
      footer.innerHTML = '';
      return;
    }

    if (status.state === 'qrcode' && status.qrcode_url) {
      const expires = status.qrcode_expires_at || 0;
      const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      const pngSrc = `/api/claw/qrcode.png?_=${Date.now()}`;
      body.innerHTML = `
        <div class="qrcode-container">
          <img src="${pngSrc}" alt="QR Code" class="qrcode-img"
               onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='block';" />
          <div class="qrcode-fallback" style="display:none;">
            <div class="qrcode-tip">⚠️ 图片加载失败，请用下方深链</div>
            <div class="qrcode-link">${escapeHtml(status.qrcode_url)}</div>
          </div>
          <div class="qrcode-tip">📱 请用微信扫描二维码登录</div>
          <div class="qrcode-countdown" id="qrcode-countdown">⏱ 二维码 ${remaining} 秒后过期</div>
          <details class="qrcode-deep-link">
            <summary>深链（备选）</summary>
            <code>${escapeHtml(status.qrcode_url)}</code>
          </details>
        </div>`;
      footer.innerHTML = `
        <button onclick="Claw.closeWechatModal()">关闭</button>
        <button class="primary" onclick="Claw.refreshClawQrcode()">🔄 刷新二维码</button>`;
    } else if (status.state === 'connected') {
      body.innerHTML = `
        <div class="claw-state-display">
          <div class="state-icon">✅</div>
          <div class="state-text">已登录</div>
          <div class="state-sub">${escapeHtml(status.nickname || '')} ${status.wxid ? `(${escapeHtml(status.wxid)})` : ''}</div>
        </div>
        <div class="claw-info">
          <div class="ci-label">昵称</div><div class="ci-value">${escapeHtml(status.nickname || '-')}</div>
          <div class="ci-label">wxid</div><div class="ci-value">${escapeHtml(status.wxid || '-')}</div>
          <div class="ci-label">adapter</div><div class="ci-value">${escapeHtml(status.adapter_name || '-')}</div>
          <div class="ci-label">连接时间</div><div class="ci-value">${status.connected_at ? new Date(status.connected_at).toLocaleString() : '-'}</div>
        </div>`;
      footer.innerHTML = `
        <button class="danger" onclick="Claw.logoutClaw()">退出登录</button>
        <button onclick="Claw.restartClaw()">🔄 重启</button>
        <button class="primary" onclick="Claw.closeWechatModal()">完成</button>`;
    } else if (status.state === 'disconnected') {
      body.innerHTML = `
        <div class="claw-state-display">
          <div class="state-icon">📱</div>
          <div class="state-text">微信未连接</div>
          <div class="state-sub">点击下方"开始登录"扫码连接</div>
        </div>`;
      footer.innerHTML = `
        <button onclick="Claw.closeWechatModal()">关闭</button>
        <button class="primary" onclick="Claw.startClawLogin()">🚀 开始登录</button>`;
    } else if (status.state === 'error' || status.state === 'banned') {
      body.innerHTML = `
        <div class="claw-state-display">
          <div class="state-icon">⚠️</div>
          <div class="state-text" style="color: var(--danger);">${status.state === 'banned' ? '账号被封' : '连接异常'}</div>
          <div class="state-sub">${escapeHtml(status.error_message || '请检查 gewechat 服务')}</div>
        </div>`;
      footer.innerHTML = `
        <button onclick="Claw.closeWechatModal()">关闭</button>
        <button class="primary" onclick="Claw.startClawLogin()">🔄 重试</button>`;
    } else {
      body.innerHTML = `
        <div class="claw-state-display">
          <div class="state-icon">⏳</div>
          <div class="state-text">${escapeHtml(status.state)}</div>
          <div class="state-sub">${escapeHtml(status.error_message || '')}</div>
        </div>`;
      footer.innerHTML = '<button onclick="Claw.closeWechatModal()">关闭</button>';
    }
  }

  function startQrcodeCountdown() {
    if (state.claw.qrcodeTimer) clearInterval(state.claw.qrcodeTimer);
    state.claw.qrcodeTimer = setInterval(() => {
      if (!state.claw.modalOpen) {
        clearInterval(state.claw.qrcodeTimer);
        state.claw.qrcodeTimer = null;
        return;
      }
      const expires = state.claw.lastQrcodeExpiresAt;
      if (!expires) return;
      const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
      const el = document.getElementById('qrcode-countdown');
      if (el) {
        el.textContent = remaining > 0 ? `⏱ 二维码 ${remaining} 秒后过期` : '❌ 二维码已过期，点击"刷新"重新获取';
        el.classList.toggle('expired', remaining === 0);
      }
    }, 1000);
  }

  async function startClawLogin() {
    try {
      showNotification('⏳ 正在生成二维码...', 'info', 2000);
      await api('/api/claw/login/start', { method: 'POST', body: {} });
      // v5.2.1: 立即拉取新状态，UI 无需等下一次轮询
      await loadClawStatus();
      renderWechatModal();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  async function refreshClawQrcode() {
    try {
      await api('/api/claw/login/start', { method: 'POST', body: {} });
      // v5.2.1: 立即刷新面板显示新二维码
      await loadClawStatus();
      renderWechatModal();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  async function logoutClaw() {
    const ok = await global.Core.openConfirm({ title: '退出登录', message: '确认退出微信登录？', confirmText: '退出' });
    if (!ok) return;
    try {
      await api('/api/claw/logout', { method: 'POST', body: {} });
      showNotification('✓ 已退出', 'success');
      await loadClawStatus();
      renderWechatModal();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  async function restartClaw() {
    const ok = await global.Core.openConfirm({ title: '重启 Claw', message: '确认重启 Claw？', confirmText: '重启' });
    if (!ok) return;
    try {
      await api('/api/claw/restart', { method: 'POST', body: {} });
      showNotification('✓ 已重启', 'success');
      await loadClawStatus();
      renderWechatModal();
    } catch (e) {
      showNotification(`❌ ${e.message}`, 'error');
    }
  }

  global.Claw = {
    loadClawStatus,
    renderClawStatus,
    openWechatModal,
    closeWechatModal,
    renderWechatModal,
    startQrcodeCountdown,
    startClawStatusPolling, // v5.2.1
    stopClawStatusPolling, // v5.2.1
    startClawLogin,
    refreshClawQrcode,
    logoutClaw,
    restartClaw
  };
})(window);
