// ==UserScript==
// @name         GitHub Issue Helper
// @namespace    https://github.com/Phil-Fan/gh-issue-helper
// @version      0.1.0
// @description  右键 issue 直接在光标处打开 GitHub 原生 Assign 面板；← / → 切换上一个/下一个 issue；可选无限滚动列表。
// @author       Phil-Fan
// @match        https://github.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-idle
// @noframes
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
    keyboardNav: true,   // ← / → 切换 issue
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

  /** 批量操作栏里的原生按钮（不是 dialog 里的、不是侧边栏里的） */
  function findBulkButton(label) {
    return (
      [...document.querySelectorAll('button')].find(
        (b) => isVisible(b) && b.textContent.trim() === label && !b.closest('[role="dialog"]'),
      ) || null
    );
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
        await waitFor(() => findBulkButton('Assign'), 1500);
      }

      const assignButton = findBulkButton('Assign');
      if (!assignButton) {
        toast('没有找到 Assign 按钮：可能没有该仓库的写权限');
        if (checkbox && !wasChecked && checkbox.checked) checkbox.click();
        return;
      }

      assignButton.click();

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
      // 列表是 React 异步渲染的，等 DOM 出现后再存顺序 / 启动无限滚动
      waitFor(listUl, 4000).then((ul) => {
        if (!ul || seq !== routeSeq) return;
        saveSnapshot();
        if (cfg.endlessScroll) startEndless();
      });
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
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function init() {
    injectStyles();

    document.addEventListener('contextmenu', onContextMenu, true);
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
