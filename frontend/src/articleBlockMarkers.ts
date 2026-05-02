/** Normalize text for comparing blocks across versions. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Fingerprint embedded media (URLs) so image/video-only edits still highlight. */
function mediaFingerprint(root: Element): string {
  const parts: string[] = [];
  root.querySelectorAll('img, video, audio, source').forEach((node) => {
    const tag = node.tagName.toLowerCase();
    const src = node.getAttribute('src') ?? '';
    const dataSrc = node.getAttribute('data-src') ?? '';
    const poster = tag === 'video' ? (node.getAttribute('poster') ?? '') : '';
    const ss = node.getAttribute('srcset') ?? '';
    parts.push(`${tag}|${src}|${dataSrc}|${poster}|${ss}`);
  });
  parts.sort();
  return parts.join('\u0001');
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
    const pm = mediaFingerprint(prevDoc.body);
    const lm = mediaFingerprint(latestDoc.body);
    if (pm !== lm || (pt !== lt && lt.length > 0)) {
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
    const prevMedia =
      i < prevBlocks.length ? mediaFingerprint(prevBlocks[i]) : '';
    const latestMedia = mediaFingerprint(latestBlocks[i]);
    if (prevText !== latestText || prevMedia !== latestMedia) {
      latestBlocks[i].classList.add('diff-block-changed');
    }
  }

  return latestDoc.body.innerHTML;
}
