// ==UserScript==
// @name         GitHub Issue Helper
// @namespace    https://github.com/Phil-Fan/gh-issue-helper
// @version      0.2.0
// @description  列表页左右分栏预览 issue 详情；右键或 hover 直接调出 GitHub 原生 Assign 面板；← / → 切换 issue；可选无限滚动。
// @author       Phil-Fan
// @match        https://github.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/Phil-Fan/gh-issue-helper/main/gh-issue-helper.user.js
// @updateURL    https://raw.githubusercontent.com/Phil-Fan/gh-issue-helper/main/gh-issue-helper.user.js
// ==/UserScript==

/**
 * GitHub Issue Helper
 *
 * 设计原则：不调用任何私有 API、不读写 token。
 * 一切写操作都通过 GitHub 自己的 React 组件完成，本脚本只做两件事：
 *   1. 把「勾选 issue → 点 Assign → 弹出面板」这一串操作自动化；
 *   2. 把弹出的原生面板移动到鼠标右键的位置。
 * 因此权限、校验、assignee 搜索、多选、Save 全部沿用 GitHub 原生行为。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 配置

  const CFG_KEY = 'ghih:config';
  const SNAP_KEY = 'ghih:lastList';
  const PAGE_CACHE_KEY = 'ghih:pageCache';

  const DEFAULTS = {
    keyboardNav: true,    // ← / → 切换 issue
    splitView: true,      // 列表页左右分栏：左侧列表，右侧详情预览
    endlessScroll: false, // 列表页无限滚动（默认关闭）
    maxPages: 40,         // 无限滚动最多加载的页数
  };

  function loadCfg() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveCfg(patch) {
    const next = Object.assign(loadCfg(), patch);
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下可能失败，忽略 */
    }
    cfg = next;
    return next;
  }

  let cfg = loadCfg();

  // ---------------------------------------------------------------- 小工具

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 轮询直到 fn 返回真值，超时返回 null */
  async function waitFor(fn, timeout = 2000, interval = 60) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = fn();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  const isVisible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;

  /** 取最上层可见的 dialog（GitHub 的 SelectPanel） */
  function lastVisibleDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
    return dialogs.length ? dialogs[dialogs.length - 1] : null;
  }

  // ---------------------------------------------------------------- 路由判断

  const RE_DETAIL = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#]|$)/;
  const RE_LIST = /^\/([^/]+)\/([^/]+)\/issues\/?(?:[?#]|$)/;

  function detailInfo() {
    const m = location.pathname.match(RE_DETAIL);
    if (!m) return null;
    return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  }

  function listInfo() {
    const m = location.pathname.match(RE_LIST);
    if (!m) return null;
    return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}`, url: location.href };
  }

  // ---------------------------------------------------------------- Toast

  let toastEl = null;
  let toastTimer = 0;

  function toast(message, ms = 2000) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ghih-toast';
      toastEl.setAttribute('role', 'status');
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('ghih-toast--on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('ghih-toast--on'), ms);
  }

  // ---------------------------------------------------------------- 核心：复用原生 Assign 面板

  /**
   * 触发原生 Assign 面板。
   * 宽度足够时工具栏会直接显示 Assign 按钮；分栏变窄后 GitHub 会把它折叠进「更多」菜单，
   * 所以两种入口都要处理。
   */
  async function triggerAssignPanel() {
    const direct = [...document.querySelectorAll('button')].find(
      (b) =>
        isVisible(b) &&
        b.textContent.trim() === 'Assign' &&
        !b.closest('[role="dialog"]') &&
        !b.classList.contains('ghih-row-assign'),
    );
    if (direct) {
      direct.click();
      return true;
    }

    const toolbar = document.querySelector('[role="toolbar"][aria-label="Issue actions"]');
    if (!toolbar) return false;

    const more = [...toolbar.querySelectorAll('button')].find(
      (b) => isVisible(b) && b.textContent.trim() === '' && b.getAttribute('aria-haspopup') === 'true',
    );
    if (!more) return false;

    more.click();
    const item = await waitFor(
      () =>
        [...document.querySelectorAll('[role="menuitem"]')].find(
          (el) => isVisible(el) && /^assign$/i.test(el.textContent.trim()),
        ),
      1500,
    );
    if (!item) {
      document.body.click(); // 关掉溢出菜单
      return false;
    }
    item.click();
    return true;
  }

  /**
   * 把弹出层挪到 (x, y)，并夹在视口内。
   *
   * GitHub 用 CSS anchor positioning（position-anchor + inset-area）定位这个面板，
   * 直接写 left/top 会被那条规则覆盖，所以这里改用 transform 做纯视觉位移。
   * transform 是绝对替换值，必须先记住「未位移时」的基准位置，否则反复校正会互相抵消。
   */
  const overlayBase = new WeakMap();

  function placeOverlay(el, x, y, pad = 8) {
    if (!overlayBase.has(el)) overlayBase.set(el, el.getBoundingClientRect());
    const base = overlayBase.get(el);
    const cur = el.getBoundingClientRect();
    const w = cur.width || 320;
    const h = cur.height || 280;

    const left = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - h - pad));

    const dx = Math.round(left - base.left);
    const dy = Math.round(top - base.top);

    el.style.setProperty('transition', 'none', 'important');
    el.style.setProperty('transform', `translate(${dx}px, ${dy}px)`, 'important');
  }

  /** 面板内容异步渲染会改变高度，用几帧时间反复校准位置 */
  function pinOverlay(el, x, y) {
    overlayBase.delete(el);
    const schedule = [0, 60, 160, 320, 600];
    schedule.forEach((delay) => {
      setTimeout(() => {
        if (document.contains(el) && el.getAttribute('data-visibility-visible') !== null) placeOverlay(el, x, y);
      }, delay);
    });
  }

  /** 面板关闭后做清理（恢复勾选状态） */
  function watchPanelClose(panel, onClose) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      try {
        onClose();
      } catch {
        /* noop */
      }
    };

    const observer = new MutationObserver(() => {
      if (!document.contains(panel) || panel.getAttribute('data-visibility-visible') === null) finish();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-visibility-visible', 'hidden', 'style', 'class'],
    });

    // 兜底：Escape 关闭时属性可能先变再移除节点
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') setTimeout(() => !document.contains(panel) && finish(), 300);
      },
      { once: true, capture: true },
    );
  }

  /** 列表页：右键某一行，打开原生批量 Assign 面板并移到光标处 */
  async function openAssignForRow(row, x, y) {
    const link = row.querySelector('[data-testid="issue-listitem-title-link"]');
    const href = link && link.getAttribute('href');

    // 无限滚动追加的行不在 React 树里，勾选不会触发原生状态 -> 走详情页
    if (row.dataset.ghihAppended === '1' && href) {
      toast('该行由无限滚动加载，正在打开 issue 分配…');
      const url = new URL(href, location.origin);
      url.hash = 'ghih-assign';
      location.href = url.toString();
      return;
    }

    const checkbox = row.querySelector('input[type="checkbox"]');
    const wasChecked = !!(checkbox && checkbox.checked);

    try {
      if (checkbox && !wasChecked) {
        checkbox.click();
        await waitFor(() => document.querySelector('[role="toolbar"][aria-label="Issue actions"]'), 1500);
      }

      const triggered = await triggerAssignPanel();
      if (!triggered) {
        toast('没有找到 Assign 入口：可能没有该仓库的写权限');
        if (checkbox && !wasChecked && checkbox.checked) checkbox.click();
        return;
      }

      const panel = await waitFor(lastVisibleDialog, 3000);
      if (!panel) {
        toast('Assign 面板没有打开');
        if (checkbox && !wasChecked && checkbox.checked) checkbox.click();
        return;
      }

      pinOverlay(panel, x, y);

      watchPanelClose(panel, () => {
        if (checkbox && !wasChecked && checkbox.checked) checkbox.click();
      });
    } catch (err) {
      console.warn('[gh-issue-helper]', err);
      if (checkbox && !wasChecked && checkbox.checked) checkbox.click();
    }
  }

  /** 详情页：打开原生侧边栏 Assign 面板，并移到指定位置 */
  async function openAssignOnDetail(x, y) {
    const section = document.querySelector('[data-testid="sidebar-assignees-section"]');
    const button = section && section.querySelector('button[data-component="Button"]');
    if (!button) {
      toast('当前页面没有 Assign 按钮：可能没有该仓库的写权限');
      return;
    }
    button.click();
    const panel = await waitFor(lastVisibleDialog, 3000);
    if (!panel) {
      toast('Assign 面板没有打开');
      return;
    }
    pinOverlay(panel, x, y);
  }

  // ---------------------------------------------------------------- 右键

  function onContextMenu(event) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return; // 保留原生菜单

    const list = listInfo();
    if (!list) return;

    const link = event.target.closest && event.target.closest('[data-testid="issue-listitem-title-link"]');
    const row = link && link.closest('li');
    if (!row) return;

    event.preventDefault();
    event.stopPropagation();
    openAssignForRow(row, event.clientX, event.clientY);
  }

  // ---------------------------------------------------------------- 列表快照 & 翻页

  function readVisibleNumbers() {
    const numbers = [];
    document.querySelectorAll('[data-testid="issue-listitem-title-link"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/issues\/(\d+)(?:[?#]|$)/);
      if (m) numbers.push(Number(m[1]));
    });
    return numbers;
  }

  function readSnapshot() {
    const info = listInfo();
    if (!info) return null;
    const url = new URL(location.href);
    return {
      repo: info.full,
      q: url.searchParams.get('q') || '',
      page: Number(url.searchParams.get('page') || 1),
      numbers: readVisibleNumbers(),
      ts: Date.now(),
    };
  }

  function saveSnapshot() {
    const snap = readSnapshot();
    if (!snap || !snap.numbers.length) return;
    try {
      sessionStorage.setItem(SNAP_KEY, JSON.stringify(snap));
    } catch {
      /* noop */
    }
  }

  function loadSnapshot() {
    try {
      const raw = sessionStorage.getItem(SNAP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** 从列表页 HTML 中提取 issue 编号和是否有下一页 */
  function parseListHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const numbers = [];
    doc.querySelectorAll('[data-testid="issue-listitem-title-link"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/issues\/(\d+)(?:[?#]|$)/);
      if (m) numbers.push(Number(m[1]));
    });
    const hasNext = [...doc.querySelectorAll('a[href*="page="]')].some((a) => /^next$/i.test(a.textContent.trim()));
    return { numbers, hasNext };
  }

  function listPageUrl(repo, q, page) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return `/${repo}/issues${qs ? `?${qs}` : ''}`;
  }

  function readPageCache() {
    try {
      return JSON.parse(sessionStorage.getItem(PAGE_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function writePageCache(cache) {
    try {
      sessionStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* noop */
    }
  }

  /** 抓一页列表（带 5 分钟缓存） */
  async function fetchListPage(repo, q, page) {
    const key = `${repo}|${q}|${page}`;
    const cache = readPageCache();
    const hit = cache[key];
    if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;

    const res = await fetch(listPageUrl(repo, q, page), {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`列表请求失败: ${res.status}`);
    const data = parseListHtml(await res.text());

    cache[key] = { ts: Date.now(), data };
    // 只保留最近 40 页缓存
    const keys = Object.keys(cache);
    if (keys.length > 40) keys.slice(0, keys.length - 40).forEach((k) => delete cache[k]);
    writePageCache(cache);

    return data;
  }

  /**
   * 解析「当前 issue 在列表中的位置」。
   * 优先级：本会话记录 -> referrer/session 的筛选条件逐页查找 -> 按编号兜底。
   */
  async function resolveNavContext(currentNumber) {
    const info = detailInfo();
    if (!info) return null;

    const snap = loadSnapshot();
    if (snap && snap.repo === info.full && snap.numbers.includes(currentNumber)) {
      return {
        repo: info.full,
        q: snap.q,
        page: snap.page,
        numbers: snap.numbers,
        hasNext: true,
        source: 'session',
      };
    }

    // 用记录下来的筛选条件（或默认 open 列表）逐页找
    const q = (snap && snap.repo === info.full && snap.q) || 'is:issue state:open';
    const startPage = snap && snap.repo === info.full ? Math.max(1, snap.page - 1) : 1;

    try {
      for (let page = startPage; page <= startPage + 25; page++) {
        const { numbers, hasNext } = await fetchListPage(info.full, q, page);
        if (!numbers.length) break;
        const idx = numbers.indexOf(currentNumber);
        if (idx !== -1) {
          return { repo: info.full, q, page, numbers, hasNext, source: 'scan' };
        }
        if (!hasNext) break;
      }
    } catch (err) {
      console.warn('[gh-issue-helper] 列表定位失败', err);
    }

    return null;
  }

  /** ← / → 跳转 */
  async function stepIssue(direction) {
    const info = detailInfo();
    if (!info) return;

    toast('正在定位列表顺序…', 1200);
    const ctx = await resolveNavContext(info.number);
    if (!ctx) {
      // 找不到列表上下文时按编号兜底
      const target = info.number + direction;
      if (target < 1) return toast('已经是第一个 issue');
      location.href = `/${info.full}/issues/${target}`;
      return;
    }

    let idx = ctx.numbers.indexOf(info.number);

    if (direction > 0 && idx === ctx.numbers.length - 1) {
      // 到达当前页末尾，加载下一页
      if (ctx.hasNext) {
        try {
          const nextPage = ctx.page + 1;
          const data = await fetchListPage(ctx.repo, ctx.q, nextPage);
          if (data.numbers.length) {
            ctx.numbers = ctx.numbers.concat(data.numbers.filter((n) => !ctx.numbers.includes(n)));
            ctx.page = nextPage;
          }
        } catch (err) {
          console.warn('[gh-issue-helper]', err);
        }
      }
    }

    if (direction < 0 && idx === 0) {
      if (ctx.page > 1) {
        try {
          const prevPage = ctx.page - 1;
          const data = await fetchListPage(ctx.repo, ctx.q, prevPage);
          if (data.numbers.length) {
            ctx.numbers = data.numbers.concat(ctx.numbers.filter((n) => !data.numbers.includes(n)));
            ctx.page = prevPage;
            idx = ctx.numbers.indexOf(info.number);
          }
        } catch (err) {
          console.warn('[gh-issue-helper]', err);
        }
      }
    }

    idx = ctx.numbers.indexOf(info.number);
    const target = ctx.numbers[idx + direction];
    if (!target) {
      toast(direction > 0 ? '已经是列表里的最后一个 issue' : '已经是列表里的第一个 issue');
      return;
    }

    try {
      sessionStorage.setItem(
        SNAP_KEY,
        JSON.stringify({ repo: ctx.repo, q: ctx.q, page: ctx.page, numbers: ctx.numbers, ts: Date.now() }),
      );
    } catch {
      /* noop */
    }

    location.href = `/${ctx.repo}/issues/${target}`;
  }

  function onKeyDown(event) {
    if (!cfg.keyboardNav) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const target = event.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
    if (lastVisibleDialog()) return;

    if (!detailInfo()) return;

    event.preventDefault();
    stepIssue(event.key === 'ArrowRight' ? 1 : -1);
  }

  // ---------------------------------------------------------------- 无限滚动

  const endless = {
    observer: null,
    sentinel: null,
    page: 1,
    hasNext: false,
    loading: false,
    repo: null,
    q: '',
  };

  function listUl() {
    const link = document.querySelector('[data-testid="issue-listitem-title-link"]');
    return link ? link.closest('ul') : null;
  }

  function readHasNext() {
    return [...document.querySelectorAll('a[href*="page="]')].some((a) => /^next$/i.test(a.textContent.trim()));
  }

  function stopEndless() {
    if (endless.observer) endless.observer.disconnect();
    if (endless.sentinel) endless.sentinel.remove();
    document.querySelectorAll('li[data-ghih-appended="1"]').forEach((el) => el.remove());
    endless.observer = null;
    endless.sentinel = null;
    endless.loading = false;
  }

  async function loadMoreRows() {
    if (endless.loading || !endless.hasNext) return;
    endless.loading = true;

    try {
      if (endless.page >= cfg.maxPages) {
        endless.hasNext = false;
        toast(`已加载 ${cfg.maxPages} 页，停止继续加载`);
        return;
      }

      const targetPage = endless.page + 1;
      const res = await fetch(listPageUrl(endless.repo, endless.q, targetPage), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ul = listUl();
      if (!ul) return;

      const existing = new Set(
        [...ul.querySelectorAll('[data-testid="issue-listitem-title-link"]')].map((a) =>
          (a.getAttribute('href') || '').trim(),
        ),
      );

      let added = 0;
      doc.querySelectorAll('li').forEach((li) => {
        const link = li.querySelector('[data-testid="issue-listitem-title-link"]');
        if (!link) return;
        const href = (link.getAttribute('href') || '').trim();
        if (!href || existing.has(href)) return;

        const node = document.importNode(li, true);
        node.setAttribute('data-ghih-appended', '1');
        ul.appendChild(node);
        existing.add(href);
        added += 1;
      });

      endless.page = targetPage;
      endless.hasNext = [...doc.querySelectorAll('a[href*="page="]')].some((a) =>
        /^next$/i.test(a.textContent.trim()),
      );

      if (!added) endless.hasNext = false;
      else saveSnapshot();
    } catch (err) {
      console.warn('[gh-issue-helper] 无限滚动加载失败', err);
      endless.hasNext = false;
      toast('加载下一页失败');
    } finally {
      endless.loading = false;
    }
  }

  function startEndless() {
    const info = listInfo();
    const ul = listUl();
    if (!info || !ul || endless.observer) return;

    const url = new URL(location.href);
    endless.repo = info.full;
    endless.q = url.searchParams.get('q') || '';
    endless.page = Number(url.searchParams.get('page') || 1);
    endless.hasNext = readHasNext();

    endless.sentinel = document.createElement('div');
    endless.sentinel.className = 'ghih-sentinel';
    endless.sentinel.textContent = '滚动加载更多 issue…';
    ul.insertAdjacentElement('afterend', endless.sentinel);

    endless.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRows();
      },
      { rootMargin: '600px 0px' },
    );
    endless.observer.observe(endless.sentinel);
  }

  // ---------------------------------------------------------------- 左右分栏预览

  const split = {
    pane: null,
    bar: null,
    body: null,
    seq: 0,
    cache: new Map(),
    observer: null,
  };

  function ensureSplitPane() {
    if (!cfg.splitView) return null;
    document.body.classList.add('ghih-split');

    if (split.pane && document.contains(split.pane)) return split.pane;

    const pane = document.createElement('div');
    pane.className = 'ghih-pane';

    const bar = document.createElement('div');
    bar.className = 'ghih-pane-bar';
    bar.innerHTML =
      '<span class="ghih-pane-title">预览</span>' +
      '<a class="ghih-pane-open" target="_blank" rel="noopener">打开原页 ↗</a>';

    const body = document.createElement('div');
    body.className = 'ghih-pane-body';
    body.innerHTML = '<div class="ghih-pane-empty">点击左侧任意 issue，在这里查看详情</div>';

    pane.appendChild(bar);
    pane.appendChild(body);
    document.body.appendChild(pane);

    // 预览里的 issue 链接（包括 #909 这种交叉引用）继续在预览里打开
    pane.addEventListener('click', (event) => {
      const a = event.target.closest && event.target.closest('a[href]');
      if (!a) return;
      const url = new URL(a.href, location.origin);
      if (url.origin !== location.origin) return;
      if (!/^\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) return;
      event.preventDefault();
      showPreview(url.href);
    });

    split.pane = pane;
    split.bar = bar;
    split.body = body;
    return pane;
  }

  function teardownSplit() {
    document.body.classList.remove('ghih-split');
    if (split.pane) split.pane.remove();
    if (split.observer) split.observer.disconnect();
    split.pane = null;
    split.bar = null;
    split.body = null;
    split.observer = null;
    split.seq += 1;
    if (hoverButton) hoverButton.hidden = true;
    document.querySelectorAll('li.ghih-active').forEach((li) => li.classList.remove('ghih-active'));
  }

  async function showPreview(href, row) {
    const pane = ensureSplitPane();
    if (!pane) return;

    const url = new URL(href, location.origin);
    const seq = ++split.seq;

    document.querySelectorAll('li.ghih-active').forEach((li) => li.classList.remove('ghih-active'));
    if (row) row.classList.add('ghih-active');

    split.bar.querySelector('.ghih-pane-title').textContent = `#${url.pathname.split('/').pop()} · 只读预览`;
    split.bar.querySelector('.ghih-pane-open').href = url.href;

    if (split.body.querySelector('[class*="IssueContent"]')) {
      split.body.classList.add('ghih-loading');
    } else {
      split.body.innerHTML = '<div class="ghih-pane-loading">加载中…</div>';
    }

    let html = split.cache.get(url.pathname);
    if (!html) {
      try {
        const res = await fetch(url.pathname, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
        split.cache.set(url.pathname, html);
        if (split.cache.size > 80) split.cache.delete(split.cache.keys().next().value);
      } catch (err) {
        console.warn('[gh-issue-helper] 预览加载失败', err);
        if (seq === split.seq) split.body.innerHTML = '<div class="ghih-pane-empty">加载失败，请点右上角打开原页</div>';
        return;
      }
    }

    if (seq !== split.seq) return;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, link, meta, noscript').forEach((el) => el.remove());
    const src = doc.querySelector('[class*="IssueContent"]');
    if (!src) {
      split.body.innerHTML = '<div class="ghih-pane-empty">无法解析该 issue</div>';
      return;
    }

    split.body.innerHTML = '';
    split.body.appendChild(document.importNode(src, true));
    split.body.classList.remove('ghih-loading');
    split.body.scrollTop = 0;
  }

  /**
   * 没有 assignee 的行，hover 时在行右侧浮出一个 Assign 入口。
   *
   * 注意：不能把这个按钮插到 React 管理的 <li> 里 —— 会破坏 React 的协调，
   * 导致 checkbox 的点击不再触发选中。所以按钮挂在 body 上，用 fixed 定位跟随 hover 行。
   */
  let hoverRow = null;
  let hoverButton = null;
  let hoverFrame = 0;

  function hasAssignee(li) {
    return [...li.querySelectorAll('[class*="metadataAssignees"]')].some((cell) =>
      cell.querySelector('button[class*="assigneeFilterButton"], img'),
    );
  }

  function ensureHoverButton() {
    if (!cfg.splitView) return null;
    if (hoverButton && document.contains(hoverButton)) return hoverButton;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghih-row-assign';
    button.title = 'Assign issue';
    button.setAttribute('aria-label', 'Assign issue');
    button.hidden = true;
    button.innerHTML =
      '<svg class="octicon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
      '<path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.005 6.005 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path>' +
      '</svg><span>Assign</span>';

    // 防止点击时抢走焦点/触发行的 mousedown 逻辑
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = hoverRow || (hoverButton && hoverButton.__row);
      if (!row) return;
      const rect = button.getBoundingClientRect();
      setTimeout(() => openAssignForRow(row, rect.left, rect.bottom + 6), 0);
    });

    document.body.appendChild(button);
    hoverButton = button;
    return button;
  }

  function hideHoverButton() {
    hoverRow = null;
    if (hoverButton) hoverButton.hidden = true;
  }

  function onPointerOver(event) {
    if (!cfg.splitView || !listInfo()) return;
    if (hoverButton && (event.target === hoverButton || hoverButton.contains(event.target))) return;

    const li = event.target.closest && event.target.closest('li');
    const link = li && li.querySelector('[data-testid="issue-listitem-title-link"]');
    if (!li || !link) return hideHoverButton();
    if (hasAssignee(li)) return hideHoverButton();

    const button = ensureHoverButton();
    if (!button) return;

    hoverRow = li;
    button.__row = li;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      if (!document.contains(li) || !cfg.splitView) return hideHoverButton();
      const rect = li.getBoundingClientRect();
      if (rect.width < 240 || rect.top > window.innerHeight || rect.bottom < 0) return hideHoverButton();
      button.hidden = false;
      button.style.left = `${Math.round(rect.right - 95)}px`;
      button.style.top = `${Math.round(rect.top + rect.height / 2 - 11)}px`;
    });
  }

  /** 点击列表项 -> 右侧预览，不跳转 */
  function onListClick(event) {
    if (!cfg.splitView) return;
    if (!listInfo()) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target.closest && event.target.closest('[data-testid="issue-listitem-title-link"]');
    if (!link) return;

    event.preventDefault();
    event.stopPropagation();
    showPreview(link.href, link.closest('li'));
  }

  // ---------------------------------------------------------------- 设置菜单

  const menuIds = [];

  function refreshMenu() {
    menuIds.splice(0).forEach((id) => {
      try {
        GM_unregisterMenuCommand(id);
      } catch {
        /* noop */
      }
    });

    const add = (label, fn) => {
      try {
        const id = GM_registerMenuCommand(label, fn);
        if (id) menuIds.push(id);
      } catch {
        /* noop */
      }
    };

    add(`${cfg.keyboardNav ? '✓' : '✗'} 键盘 ← / → 切换 issue`, () => {
      saveCfg({ keyboardNav: !cfg.keyboardNav });
      toast(`键盘导航：${cfg.keyboardNav ? '开启' : '关闭'}`);
      refreshMenu();
    });

    add(`${cfg.endlessScroll ? '✓' : '✗'} 无限滚动（不换页）`, () => {
      saveCfg({ endlessScroll: !cfg.endlessScroll });
      toast(`无限滚动：${cfg.endlessScroll ? '开启' : '关闭'}`);
      refreshMenu();
      applyRoute();
    });

    add(`${cfg.splitView ? '✓' : '✗'} 左右分栏预览（右栏看详情）`, () => {
      saveCfg({ splitView: !cfg.splitView });
      toast(`左右分栏：${cfg.splitView ? '开启' : '关闭'}`);
      refreshMenu();
      if (!cfg.splitView) teardownSplit();
      applyRoute();
    });

    add('恢复默认设置', () => {
      saveCfg({ ...DEFAULTS });
      toast('已恢复默认设置');
      refreshMenu();
      applyRoute();
    });
  }

  // ---------------------------------------------------------------- 路由生命周期

  let lastPath = '';
  let routeSeq = 0;

  function applyRoute() {
    const seq = ++routeSeq;
    const path = location.pathname + location.search;

    if (path !== lastPath) {
      lastPath = path;
      stopEndless(); // 换页/换路由时清掉上一页追加的节点
    }

    const list = listInfo();
    const detail = detailInfo();

    if (list) {
      // 列表是 React 异步渲染的，等 DOM 出现后再存顺序 / 启动无限滚动 / 挂载分栏
      waitFor(listUl, 4000).then((ul) => {
        if (!ul || seq !== routeSeq) return;
        saveSnapshot();
        if (cfg.endlessScroll) startEndless();
        if (cfg.splitView) {
          ensureSplitPane();
          ensureHoverButton();
        }
      });
    } else {
      teardownSplit();
    }

    if (detail && location.hash === '#ghih-assign') {
      history.replaceState(null, '', location.pathname + location.search);
      waitFor(() => document.querySelector('[data-testid="sidebar-assignees-section"]'), 5000).then((section) => {
        if (!section || seq !== routeSeq) return;
        openAssignOnDetail(window.innerWidth / 2 - 160, 120);
      });
    }
  }

  // ---------------------------------------------------------------- 启动

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'ghih-style';
    style.textContent = `
      .ghih-toast {
        position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(8px);
        z-index: 2147483000; max-width: 70vw;
        padding: 8px 14px; border-radius: 8px;
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
        color: var(--fgColor-default, #1f2328);
        background: var(--bgColor-default, #fff);
        border: 1px solid var(--borderColor-default, #d0d7de);
        box-shadow: var(--shadow-floating-small, 0 8px 24px rgba(31, 35, 40, .2));
        opacity: 0; pointer-events: none; transition: opacity .15s ease, transform .15s ease;
      }
      .ghih-toast--on { opacity: 1; transform: translateX(-50%) translateY(0); }
      .ghih-sentinel {
        padding: 16px; text-align: center; font-size: 12px;
        color: var(--fgColor-muted, #59636e);
      }

      /* ---- 左右分栏 ---- */
      body.ghih-split { overflow-x: hidden; --ghih-left: clamp(400px, 40vw, 720px); }
      body.ghih-split [class*="PageLayoutRoot"] {
        width: var(--ghih-left) !important; max-width: var(--ghih-left) !important;
      }
      body.ghih-split aside[class*="Sidebar__"] { display: none !important; }

      .ghih-pane {
        position: fixed; top: 0; bottom: 0; left: var(--ghih-left, 40vw); right: 0;
        display: flex; flex-direction: column;
        background: var(--bgColor-default, #fff);
        border-left: 1px solid var(--borderColor-default, #d0d7de);
        z-index: 2147482000;
      }
      .ghih-pane-bar {
        flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 6px 16px; font-size: 12px; font-weight: 600; line-height: 1.7;
        color: var(--fgColor-muted, #59636e);
        background: var(--bgColor-muted, #f6f8fa);
        border-bottom: 1px solid var(--borderColor-default, #d0d7de);
      }
      .ghih-pane-open { font-size: 12px; font-weight: 600; text-decoration: none; color: var(--fgColor-accent, #0969da); }
      .ghih-pane-open:hover { text-decoration: underline; }
      .ghih-pane-body {
        flex: 1; overflow-y: auto; overflow-x: hidden;
        padding: 8px clamp(16px, 3vw, 36px) 48px;
        transition: opacity .12s ease;
      }
      .ghih-pane-body.ghih-loading { opacity: .45; }
      .ghih-pane-body [data-testid="issue-viewer-metadata-container"],
      .ghih-pane-body [data-testid="sticky-sidebar"],
      .ghih-pane-body [data-testid="comment-composer"],
      .ghih-pane-body [data-testid="edit-issue-title-button"] { display: none !important; }
      .ghih-pane-body [class*="contentAndSidebarWrapper"] { display: block !important; }
      .ghih-pane-body [class*="contentArea"] { width: 100% !important; max-width: 100% !important; }
      .ghih-pane-empty, .ghih-pane-loading {
        padding: 48px 20px; text-align: center; font-size: 13px;
        color: var(--fgColor-muted, #59636e);
      }

      /* ---- 行内 hover 的 Assign 入口（浮层，不插入 React DOM） ---- */
      .ghih-row-assign {
        position: fixed; z-index: 2147482100;
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        height: 22px; padding: 0 9px;
        font-size: 11px; font-weight: 600; line-height: 1;
        color: var(--fgColor-muted, #59636e);
        background: var(--bgColor-default, #fff);
        border: 1px solid var(--borderColor-default, #d0d7de);
        border-radius: 999px; cursor: pointer;
        box-shadow: var(--shadow-resting-small, 0 1px 4px rgba(31, 35, 40, .12));
        transition: color .12s ease, background-color .12s ease;
      }
      .ghih-row-assign[hidden] { display: none; }
      .ghih-row-assign:hover { color: var(--fgColor-default, #1f2328); background: var(--bgColor-muted, #f6f8fa); }
      .ghih-pane-body a[href*="/issues/new"] { display: none !important; }
      .ghih-pane-body [data-testid="issue-header"] button { display: none !important; }
      li.ghih-active { background: var(--bgColor-accent-muted, rgba(9, 105, 218, .08)); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function init() {
    injectStyles();

    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('click', onListClick, true);
    document.addEventListener('mouseover', onPointerOver, true);
    document.addEventListener('scroll', hideHoverButton, true);
    window.addEventListener('resize', hideHoverButton);
    document.addEventListener('keydown', onKeyDown, false);

    // 离开列表页前保存顺序（点击 issue 链接时也存一次，Turbo 导航不会触发 unload）
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target.closest && e.target.closest('[data-testid="issue-listitem-title-link"]')) saveSnapshot();
      },
      true,
    );

    window.addEventListener('popstate', applyRoute);
    document.addEventListener('turbo:load', applyRoute);

    // GitHub 的客户端路由：轮询兜底
    setInterval(() => {
      if (location.pathname + location.search !== lastPath) applyRoute();
    }, 700);

    refreshMenu();
    applyRoute();

    console.info('[gh-issue-helper] 已加载');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
