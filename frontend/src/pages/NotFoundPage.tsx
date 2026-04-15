import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="nf404-page">
      <div className="nf404">
        <div className="nf404-orbit" aria-hidden>
          <span className="nf404-dot" />
          <span className="nf404-dot nf404-dot--lag" />
        </div>
        <div className="nf404-xml" aria-hidden>
          <span className="nf404-tag">&lt;item&gt;</span>
          <span className="nf404-tag nf404-tag--ghost">???</span>
          <span className="nf404-tag nf404-tag--end">&lt;/item&gt;</span>
        </div>
        <p className="nf404-kicker">Ничего не подтянулось</p>
        <h1 className="nf404-title">404</h1>
        <p className="nf404-lead">
          Такого адреса нет в нашем хранилище — как будто пост соскользнул с ленты до того, как мы
          его сохранили.
        </p>
        <p className="nf404-hint muted small">
          Проверьте ссылку или вернитесь к списку статей: там всё по GUID и месту.
        </p>
        <div className="nf404-actions">
          <Link to="/" className="btn-secondary">
            К статьям
          </Link>
          <button
            type="button"
            className="btn-ghost btn-compact"
            onClick={() => window.history.back()}
          >
            Назад
          </button>
        </div>
      </div>
    </div>
  );
}
