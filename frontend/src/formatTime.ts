export function formatDateTime(iso: string | null | undefined): {
  display: string;
  title: string;
} {
  if (iso == null || iso === '') {
    return { display: '—', title: '' };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { display: iso, title: iso };
  }
  return {
    display: d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    title: iso,
  };
}

/** Shorter single line for article byline (source + date). */
export function formatDateTimeCompact(iso: string | null | undefined): {
  display: string;
  title: string;
} {
  if (iso == null || iso === '') {
    return { display: '—', title: '' };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { display: iso, title: iso };
  }
  return {
    display: d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    title: iso,
  };
}
