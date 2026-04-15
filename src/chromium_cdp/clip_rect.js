(function () {
  const maxH = @@MAX_H@@;
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '#article',
    '#content',
    '.article',
    '.post',
    '.entry-content',
    '.article__text',
    '.news-detail'
  ];
  const el = (function () {
    for (const s of selectors) {
      try {
        const e = document.querySelector(s);
        if (!e) continue;
        const sh = Math.max(e.scrollHeight || 0, e.clientHeight || 0);
        if (sh > 400) return e;
      } catch (_) {}
    }
    return document.body;
  })();
  const r = el.getBoundingClientRect();
  const sx = window.scrollX || 0;
  const sy = window.scrollY || 0;
  let x = Math.max(0, Math.floor(r.left + sx));
  let y = Math.max(0, Math.floor(r.top + sy));
  let w = Math.ceil(Math.max(el.scrollWidth || 0, el.clientWidth || 0, r.width || 0));
  const docW = document.documentElement ? document.documentElement.scrollWidth : w;
  const docH = document.documentElement ? document.documentElement.scrollHeight : 0;

  function deepestContentBottom(root) {
    let max = 0;
    function walk(node) {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'META') return;
      let cs;
      try {
        cs = window.getComputedStyle(node);
      } catch (_) {
        return;
      }
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if ((parseFloat(cs.opacity) || 1) < 0.05) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const bottom = rect.bottom + sy;
      if (bottom > max) max = bottom;
      const ch = node.children;
      if (!ch) return;
      for (let i = 0; i < ch.length; i++) walk(ch[i]);
    }
    walk(root);
    return max;
  }

  const docBottom = deepestContentBottom(el);
  const hLoose = Math.ceil(Math.max(el.scrollHeight || 0, el.clientHeight || 0, r.height || 0));
  let hTight = Math.ceil(docBottom - y);
  if (!isFinite(hTight) || hTight < 80) {
    hTight = hLoose;
  } else {
    hTight = Math.min(hTight, hLoose);
  }
  // Высота только по контенту (hTight / doc), без принудительного h >= r.height:
  // layout-бокс article/main часто выше последней отрисованной строки (min-height, flex,
  // пустой колонтитул) — ниже в headless Chromium даёт однотонный чёрный/пустой кадр.
  let h = Math.min(hTight, docH > y ? docH - y : hTight, maxH);
  w = Math.min(Math.max(w, 1), Math.max(1, docW - x));
  h = Math.min(Math.max(h, 1), maxH);
  return { x, y, w, h };
})()
