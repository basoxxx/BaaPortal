import { Component, type ErrorInfo, type ReactNode } from 'react';
import { i18next } from './i18n';

interface State {
  failed: boolean;
}

/** Evita la finestra vuota quando un componente lancia: mostra un messaggio invece dell'albero. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <FatalError />;
  }
}

/** Testo di errore a prova di avvio fallito: se i18n non è pronto usa un testo fisso. */
export function FatalError() {
  const text = i18next.isInitialized
    ? i18next.t('errors.fatal')
    : 'Si è verificato un errore imprevisto. Riavvia BaaPortal.';
  return (
    <div role="alert" className="baa-fatal" style={{ padding: 24 }}>
      {text}
    </div>
  );
}
