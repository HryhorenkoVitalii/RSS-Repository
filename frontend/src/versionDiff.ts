import { diffWords } from 'diff';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** For HTML attribute values (e.g. title tooltips). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export type DiffTooltips = {
  /** Shown on &lt;ins&gt; segments */
  added: string;
  /** Shown on &lt;del&gt; segments */
  removed: string;
};

/** Strip tags for plain-text diff using safe DOMParser (no script execution). */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

export function inlineWordDiffHtml(
  prevPlain: string,
  nextPlain: string,
  tooltips?: DiffTooltips,
): string {
  const parts = diffWords(prevPlain, nextPlain);
  return parts
    .map((p) => {
      if (p.added) {
        const tip =
          tooltips != null
            ? ` title="${escapeAttr(tooltips.added)}"`
            : '';
        return `<ins class="diff-ins"${tip}>${escapeHtml(p.value)}</ins>`;
      }
      if (p.removed) {
        const tip =
          tooltips != null
            ? ` title="${escapeAttr(tooltips.removed)}"`
            : '';
        return `<del class="diff-del"${tip}>${escapeHtml(p.value)}</del>`;
      }
      return escapeHtml(p.value);
    })
    .join('');
}

export function inlineWordDiffTitleHtml(
  prevTitle: string,
  nextTitle: string,
  tooltips?: DiffTooltips,
): string | null {
  if (prevTitle === nextTitle) return null;
  return inlineWordDiffHtml(prevTitle, nextTitle, tooltips);
}
