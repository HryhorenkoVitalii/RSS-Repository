/** Normalize text for comparing blocks across versions. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Compare previous vs latest article HTML and add `diff-block-changed` on latest elements
 * whose text differs from the aligned block in the previous snapshot.
 * Keeps latest markup intact (spacing, tags) — only adds classes.
 */
export function markChangedBlocks(prevHtml: string, latestHtml: string): string {
  const prevDoc = new DOMParser().parseFromString(prevHtml || '', 'text/html');
  const latestDoc = new DOMParser().parseFromString(latestHtml || '', 'text/html');

  const BLOCK_SEL =
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, td, th, dt, dd';

  const prevBlocks = [...prevDoc.body.querySelectorAll(BLOCK_SEL)];
  const latestBlocks = [...latestDoc.body.querySelectorAll(BLOCK_SEL)];

  if (latestBlocks.length === 0) {
    const pt = normalizeWs(prevDoc.body.textContent || '');
    const lt = normalizeWs(latestDoc.body.textContent || '');
    if (pt !== lt && lt.length > 0) {
      const wrap = latestDoc.createElement('div');
      wrap.className = 'diff-body-changed';
      while (latestDoc.body.firstChild) {
        wrap.appendChild(latestDoc.body.firstChild);
      }
      latestDoc.body.appendChild(wrap);
    }
    return latestDoc.body.innerHTML;
  }

  for (let i = 0; i < latestBlocks.length; i++) {
    const prevText =
      i < prevBlocks.length ? normalizeWs(prevBlocks[i].textContent || '') : '';
    const latestText = normalizeWs(latestBlocks[i].textContent || '');
    if (prevText !== latestText) {
      latestBlocks[i].classList.add('diff-block-changed');
    }
  }

  return latestDoc.body.innerHTML;
}
