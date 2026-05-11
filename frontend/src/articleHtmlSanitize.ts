import DOMPurify from 'dompurify';

function videoSrcUnplayableInBrowser(src: string): boolean {
  const u = src.toLowerCase();
  return (
    u.includes('googlevideo.com') ||
    u.includes('youtube.com/v/') ||
    u.includes('youtube-nocookie.com/v/') ||
    u.includes('music.youtube.com/v/') ||
    u.includes('youtube.com/watch?') ||
    u.includes('youtube.com/shorts/')
  );
}

/** Убирает &lt;video&gt; с URL, которые не являются прямым потоком (MRSS YouTube и т.д.). */
function stripUnplayableEmbeddedVideoTags(html: string): string {
  if (!html.toLowerCase().includes('<video')) return html;
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('video').forEach((el) => {
      const v = el as HTMLVideoElement;
      const srcs: string[] = [];
      const main = v.getAttribute('src');
      if (main) srcs.push(main);
      v.querySelectorAll('source').forEach((s) => {
        const u = s.getAttribute('src');
        if (u) srcs.push(u);
      });
      if (srcs.some(videoSrcUnplayableInBrowser)) v.remove();
    });
    return tpl.innerHTML;
  } catch {
    return html;
  }
}

/** HTML тела статьи для вставки в страницу (как на ArticlePage). */
export function sanitizeArticleBodyHtml(html: string): string {
  return DOMPurify.sanitize(stripUnplayableEmbeddedVideoTags(html), {
    ADD_TAGS: ['video', 'source', 'audio', 'iframe'],
    ADD_ATTR: ['controls', 'preload', 'src', 'type', 'style', 'alt', 'poster', 'allowfullscreen'],
  });
}
