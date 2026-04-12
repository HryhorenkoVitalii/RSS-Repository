import { diffWords } from 'diff';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip tags for plain-text diff using safe DOMParser (no script execution). */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

export function inlineWordDiffHtml(prevPlain: string, nextPlain: string): string {
  const parts = diffWords(prevPlain, nextPlain);
  return parts
    .map((p) => {
      if (p.added) {
        return `<ins class="diff-ins">${escapeHtml(p.value)}</ins>`;
      }
      if (p.removed) {
        return `<del class="diff-del">${escapeHtml(p.value)}</del>`;
      }
      return escapeHtml(p.value);
    })
    .join('');
}

export function inlineWordDiffTitleHtml(
  prevTitle: string,
  nextTitle: string,
): string | null {
  if (prevTitle === nextTitle) return null;
  return inlineWordDiffHtml(prevTitle, nextTitle);
}
