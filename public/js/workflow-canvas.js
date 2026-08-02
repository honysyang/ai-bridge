/* ============================================================
   workflow-canvas.js — 工作流可视化画布（编辑/只读双模式）
   原生实现，无第三方依赖。
   ============================================================ */

const NODE_W = 180;
const NODE_H = 76; // 节点内容区高度，标题栏占一部分
const ANCHOR_R = 6;

/**
 * 创建画布组件。
 * opts:
 *   - el: 容器 HTMLElement（必须已设置 position 与宽高）
 *   - editable: 是否可编辑（默认 false）
 *   - onChange(steps): 编辑模式下状态变化回调
 *   - onSelectNode(node, index): 点选/取消点选节点回调
 *   - onNodeClick(node, index): 点击节点（只读模式下打开抽屉）
 *   - onEdgeClick(fromIndex, toIndex): 点击已存在连线
 *   - onError(message): 错误提示（如成环）回调
 */
export function createWorkflowCanvas(opts) {
  const {
    el,
    editable = false,
    onChange = () => {},
    onSelectNode = () => {},
    onNodeClick = () => {},
    onEdgeClick = () => {},
    onError = () => {},
  } = opts;

  if (!el) throw new Error('workflow-canvas requires el');

  // ---- DOM ----
  el.classList.add('wf-canvas-wrap');
  el.innerHTML = `
    <div class="wf-canvas-viewport">
      <div class="wf-canvas-grid"></div>
      <svg class="wf-canvas-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="wf-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent)" />
          </marker>
        </defs>
      </svg>
      <div class="wf-canvas-nodes"></div>
    </div>
    <div class="wf-canvas-hint ${editable ? '' : 'hidden'}">滚轮缩放 · 拖拽空白平移 · 拖动节点</div>
  `;
  const viewport = el.querySelector('.wf-canvas-viewport');
  const grid = el.querySelector('.wf-canvas-grid');
  const svg = el.querySelector('.wf-canvas-svg');
  const nodesLayer = el.querySelector('.wf-canvas-nodes');

  // ---- 状态 ----
  let steps = [];
  let transform = { s: 1, x: 0, y: 0 };
  let selectedIndex = null;
  let draggingNode = null; // { index, startX, startY, mouseX, mouseY }
  let panning = null; // { startX, startY, tx, ty }
  let edgeDrag = null; // { fromIndex, pathEl, overlayDot }

  // 构建容器与节点索引之间的坐标转换
  function toCanvas(clientX, clientY) {
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left - transform.x) / transform.s,
      y: (clientY - rect.top - transform.y) / transform.s,
    };
  }

  function applyTransform() {
    viewport.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.s})`;
    grid.style.backgroundSize = `${20 / transform.s}px ${20 / transform.s}px`;
  }
  applyTransform();

  // ---- 拓扑/布局辅助 ----
  function hasCycle(stepsCandidate) {
    const n = stepsCandidate.length;
    const adj = stepsCandidate.map((s) => (s.depends_on || []).filter((d) => d >= 0 && d < n));
    const seen = new Set();
    const rec = new Set();
    function dfs(i) {
      if (rec.has(i)) return true;
      if (seen.has(i)) return false;
      seen.add(i);
      rec.add(i);
      for (const d of adj[i]) if (dfs(d)) return true;
      rec.delete(i);
      return false;
    }
    for (let i = 0; i < n; i++) if (dfs(i)) return true;
    return false;
  }

  function computeLayering() {
    // 计算最长路径分层
    const n = steps.length;
    const inDegree = new Array(n).fill(0);
    const adj = steps.map((s, i) => (s.depends_on || []).filter((d) => d >= 0 && d < n));
    for (let i = 0; i < n; i++) {
      for (const d of adj[i]) inDegree[i]++;
    }
    const layer = new Array(n).fill(0);
    const queue = [];
    for (let i = 0; i < n; i++) if (inDegree[i] === 0) queue.push(i);
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      for (let j = 0; j < n; j++) {
        if (adj[j].includes(i)) {
          layer[j] = Math.max(layer[j], layer[i] + 1);
          inDegree[j]--;
          if (inDegree[j] === 0) queue.push(j);
        }
      }
    }
    const buckets = [];
    for (let i = 0; i < n; i++) {
      const l = layer[i] || 0;
      buckets[l] = buckets[l] || [];
      buckets[l].push(i);
    }
    return buckets;
  }

  function autoLayout() {
    if (!steps.length) return;
    const buckets = computeLayering();
    const colW = 260;
    const rowH = 120;
    const startX = 40;
    const startY = 40;
    buckets.forEach((bucket, layer) => {
      const totalH = bucket.length * rowH;
      const y0 = Math.max(startY, 80 + (200 - totalH) / 2); // 简单居中
      bucket.forEach((idx, pos) => {
        steps[idx].x = startX + layer * colW;
        steps[idx].y = y0 + pos * rowH;
      });
    });
    selectedIndex = null;
    render();
    onChange(steps);
  }

  function ensurePositions() {
    // 首次加载且无坐标时给予默认平铺位置
    let needsLayout = false;
    steps.forEach((s, i) => {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
        s.x = 40 + (i % 3) * 260;
        s.y = 40 + Math.floor(i / 3) * 140;
        needsLayout = true;
      }
    });
    return needsLayout;
  }

  // ---- 渲染 ----
  function anchorXY(nodeX, nodeY, side) {
    if (side === 'out') return { x: nodeX + NODE_W, y: nodeY + 28 };
    return { x: nodeX, y: nodeY + 28 };
  }

  function bezierPath(a, b) {
    const c1x = a.x + 80;
    const c2x = b.x - 80;
    return `M ${a.x} ${a.y} C ${c1x} ${a.y}, ${c2x} ${b.y}, ${b.x} ${b.y}`;
  }

  function renderEdges() {
    // 先清空 SVG 中的 path（保留 defs）
    while (svg.lastChild && svg.lastChild.tagName !== 'defs') svg.removeChild(svg.lastChild);
    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      const deps = s.depends_on || [];
      deps.forEach((d) => {
        if (d < 0 || d >= n) return;
        const a = anchorXY(steps[d].x, steps[d].y, 'out');
        const b = anchorXY(s.x, s.y, 'in');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', bezierPath(a, b));
        path.setAttribute('class', 'wf-edge');
        path.setAttribute('data-from', d);
        path.setAttribute('data-to', i);
        path.addEventListener('click', (e) => {
          e.stopPropagation();
          onEdgeClick(d, i);
          if (editable) {
            const ndeps = steps[i].depends_on.filter((x) => x !== d);
            if (hasCycleWithEdge(i, ndeps)) {
              onError('无法删除依赖：会导致循环依赖');
              return;
            }
            steps[i].depends_on = ndeps;
            render();
            onChange(steps);
          }
        });
        svg.appendChild(path);
      });
    }
    if (edgeDrag) {
      const a = anchorXY(steps[edgeDrag.fromIndex].x, steps[edgeDrag.fromIndex].y, 'out');
      const b = { x: edgeDrag.x, y: edgeDrag.y };
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', bezierPath(a, b));
      path.setAttribute('class', 'wf-edge wf-edge-dragging');
      svg.appendChild(path);
    }
  }

  function hasCycleWithEdge(targetIndex, newDeps) {
    const candidate = steps.map((s, i) => ({
      ...s,
      depends_on: i === targetIndex ? newDeps : (s.depends_on || []),
    }));
    return hasCycle(candidate);
  }

  function statusClass(status) {
    switch (status) {
      case 'completed': return 'wf-node-completed';
      case 'processing': return 'wf-node-processing';
      case 'failed': return 'wf-node-failed';
      case 'waiting':
      default: return 'wf-node-waiting';
    }
  }

  function renderNodes() {
    nodesLayer.innerHTML = '';
    steps.forEach((s, i) => {
      const node = document.createElement('div');
      node.className = `wf-node ${selectedIndex === i ? 'selected' : ''} ${statusClass(s.status)}`;
      node.style.left = `${s.x}px`;
      node.style.top = `${s.y}px`;
      node.dataset.index = i;

      const capText = s.capability ? `⚡ ${s.capability}` : '无能力要求';
      const agentText = s.target_agent ? `→ ${s.target_agent}` : '自动分配';
      const duration = s.task && s.task.started_at
        ? fmtDuration(s.task.started_at, s.task.completed_at || Math.floor(Date.now() / 1000))
        : '';

      node.innerHTML = `
        <div class="wf-node-head" ${editable ? 'draggable-node' : ''}>
          <span class="wf-node-title">${escapeHtml(truncate(s.name, 18))}</span>
          <span class="wf-node-index">#${i + 1}</span>
        </div>
        <div class="wf-node-body">
          <div class="wf-node-meta">${escapeHtml(capText)}</div>
          <div class="wf-node-meta faint">${escapeHtml(agentText)}</div>
          ${duration ? `<div class="wf-node-duration">⏱ ${duration}</div>` : ''}
        </div>
        ${editable ? '<div class="wf-anchor wf-anchor-in" data-anchor="in" title="接收依赖"></div><div class="wf-anchor wf-anchor-out" data-anchor="out" title="拖出连线"></div>' : ''}
      `;

      if (editable) {
        const head = node.querySelector('.wf-node-head');
        head.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          const pt = toCanvas(e.clientX, e.clientY);
          draggingNode = { index: i, offsetX: pt.x - s.x, offsetY: pt.y - s.y };
          selectNode(i);
        });

        const outAnchor = node.querySelector('.wf-anchor-out');
        outAnchor.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          const pt = toCanvas(e.clientX, e.clientY);
          edgeDrag = { fromIndex: i, x: pt.x, y: pt.y };
          renderEdges();
        });

        const inAnchor = node.querySelector('.wf-anchor-in');
        inAnchor.addEventListener('mouseup', (e) => {
          e.stopPropagation();
          if (!edgeDrag) return;
          if (edgeDrag.fromIndex === i) {
            cancelEdgeDrag();
            return;
          }
          const newDeps = [...new Set([...(s.depends_on || []), edgeDrag.fromIndex])].sort((a, b) => a - b);
          if (hasCycleWithEdge(i, newDeps)) {
            onError('会形成循环依赖');
            cancelEdgeDrag();
            return;
          }
          steps[i].depends_on = newDeps;
          cancelEdgeDrag();
          render();
          onChange(steps);
        });
      } else {
        node.addEventListener('click', () => onNodeClick(s, i));
      }

      nodesLayer.appendChild(node);
    });
  }

  function render() {
    renderEdges();
    renderNodes();
  }

  function selectNode(index) {
    selectedIndex = index;
    renderNodes();
    onSelectNode(index === null ? null : steps[index], index);
  }

  function cancelEdgeDrag() {
    edgeDrag = null;
    renderEdges();
  }

  // ---- 全局事件 ----
  function onMouseMove(e) {
    if (draggingNode) {
      const pt = toCanvas(e.clientX, e.clientY);
      steps[draggingNode.index].x = Math.max(0, pt.x - draggingNode.offsetX);
      steps[draggingNode.index].y = Math.max(0, pt.y - draggingNode.offsetY);
      render();
      onChange(steps);
      return;
    }
    if (panning) {
      transform.x = panning.tx + (e.clientX - panning.startX);
      transform.y = panning.ty + (e.clientY - panning.startY);
      applyTransform();
      return;
    }
    if (edgeDrag) {
      const pt = toCanvas(e.clientX, e.clientY);
      edgeDrag.x = pt.x;
      edgeDrag.y = pt.y;
      renderEdges();
    }
  }

  function onMouseUp(e) {
    if (draggingNode) {
      draggingNode = null;
      onChange(steps);
    }
    if (panning) {
      panning = null;
    }
    if (edgeDrag) {
      // 如果没有落到输入锚点，则取消
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || !target.classList.contains('wf-anchor-in')) {
        cancelEdgeDrag();
      }
    }
  }

  el.addEventListener('mousedown', (e) => {
    if (e.target === el || e.target === viewport || e.target === grid) {
      selectNode(null);
      panning = { startX: e.clientX, startY: e.clientY, tx: transform.x, ty: transform.y };
    }
  });

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const oldS = transform.s;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newS = Math.max(0.5, Math.min(1.5, oldS + delta));
    // 以鼠标为中心缩放
    transform.x = mx - (mx - transform.x) * (newS / oldS);
    transform.y = my - (my - transform.y) * (newS / oldS);
    transform.s = newS;
    applyTransform();
  }, { passive: false });

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  el.addEventListener('keydown', (e) => {
    if (editable && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (selectedIndex !== null && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        // 删除节点由页面处理，这里只回调
        e.preventDefault();
        onSelectNode(null);
      }
    }
  });

  // ---- 公共 API ----
  const api = {
    setSteps(newSteps) {
      steps = JSON.parse(JSON.stringify(newSteps));
      ensurePositions();
      render();
    },
    getSteps() {
      return JSON.parse(JSON.stringify(steps));
    },
    addStep(step) {
      const s = { ...step, depends_on: step.depends_on || [], x: step.x ?? 40, y: step.y ?? 40 };
      steps.push(s);
      render();
      onChange(steps);
      return steps.length - 1;
    },
    removeStep(index) {
      if (index < 0 || index >= steps.length) return;
      steps.splice(index, 1);
      // 级联更新依赖下标与内容模板变量
      steps.forEach((s) => {
        s.depends_on = s.depends_on
          .filter((d) => d !== index)
          .map((d) => (d > index ? d - 1 : d));
        s.content = reindexStepContent(s.content, index);
      });
      if (selectedIndex === index) selectedIndex = null;
      else if (selectedIndex > index) selectedIndex--;
      render();
      onChange(steps);
    },
    updateStep(index, patch) {
      if (index < 0 || index >= steps.length) return;
      steps[index] = { ...steps[index], ...patch };
      render();
      onChange(steps);
    },
    autoLayout() {
      autoLayout();
    },
    setScale(s) {
      transform.s = Math.max(0.5, Math.min(1.5, s));
      applyTransform();
    },
    getScale() {
      return transform.s;
    },
    getSelectedIndex() {
      return selectedIndex;
    },
    selectNode(index) {
      selectNode(index);
    },
    clearSelection() {
      selectNode(null);
    },
    destroy() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      el.innerHTML = '';
    },
  };

  return api;
}

// ---- 小工具 ----
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(s, len) {
  s = String(s ?? '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}
function fmtDuration(start, end) {
  const secs = Math.max(0, Math.round(end - start));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}
