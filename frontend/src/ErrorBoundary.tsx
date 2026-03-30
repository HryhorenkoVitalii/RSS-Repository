import { Component, type ErrorInfo, type ReactNode } from 'react';

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

  render() {
    if (this.state.error) {
      return (
        <div className="card">
          <h2 className="card-title err">Something went wrong</h2>
          <pre className="mono wrap small" style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
          </pre>
          <p className="small muted">
            Check the browser console. Ensure <code>cargo run</code> is listening on :8080 and
            this UI uses the Vite dev server (proxies <code>/api</code>).
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
