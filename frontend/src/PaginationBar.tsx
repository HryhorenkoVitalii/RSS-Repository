type Props = {
  page: number;
  totalPages: number;
  totalItems: number;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
};

export function PaginationBar({
  page,
  totalPages,
  totalItems,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: Props) {
  return (
    <div className="pagination">
      <span className="muted small">
        Page {page + 1} of {Math.max(1, totalPages)} ({totalItems} total)
      </span>
      <div className="pagination-btns">
        {canPrev ? (
          <button type="button" className="btn-secondary btn-compact" onClick={onPrev}>
            ← Prev
          </button>
        ) : null}
        {canNext ? (
          <button type="button" className="btn-secondary btn-compact" onClick={onNext}>
            Next →
          </button>
        ) : null}
      </div>
    </div>
  );
}
