import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }

  clear = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const { message, stack } = this.state.error;
      return (
        <div className="nf404-page">
          <div className="nf404">
            <div className="nf404-orbit" aria-hidden>
              <span className="nf404-dot" />
              <span className="nf404-dot nf404-dot--lag" />
            </div>
            <div className="nf404-xml" aria-hidden>
              <span className="nf404-tag">&lt;app&gt;</span>
              <span className="nf404-tag nf404-tag--ghost">!</span>
              <span className="nf404-tag nf404-tag--end">&lt;/app&gt;</span>
            </div>
            <p className="nf404-kicker">Интерфейс споткнулся</p>
            <h1 className="nf404-title">Сбой</h1>
            <p className="nf404-lead">
              Случилась непредвиденная ошибка в коде страницы. Это не ваша вина — можно вернуться
              к списку статей или обновить вкладку.
            </p>
            <p className="nf404-hint muted small">
              Если вы разработчик, загляните в консоль браузера. Для работы UI нужны{' '}
              <code>cargo run</code> на :8080 и Vite с прокси на <code>/api</code>.
            </p>
            <details className="app-error-details small muted">
              <summary className="app-error-details-summary">Техническая информация</summary>
              <pre className="app-error-details-pre mono wrap">{message}</pre>
              {stack ? (
                <pre className="app-error-details-pre mono wrap app-error-details-pre--stack">
                  {stack}
                </pre>
              ) : null}
            </details>
            <div className="nf404-actions">
              <Link to="/" className="btn-secondary" onClick={this.clear}>
                К статьям
              </Link>
              <button type="button" className="btn-ghost btn-compact" onClick={() => window.history.back()}>
                Назад
              </button>
              <button type="button" className="btn-secondary btn-compact" onClick={() => window.location.reload()}>
                Обновить страницу
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
