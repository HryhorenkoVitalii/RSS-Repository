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
