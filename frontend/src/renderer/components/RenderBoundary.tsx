import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, AlertTitle, Box } from '@mui/material';
import { shellTexts } from '@shared/texts/shell';
import { ActionButton } from './ActionButton';

interface Props {
  children: ReactNode;
  onError?: (error: Error, details: ErrorInfo) => void;
}
interface State {
  error: Error | null;
}

/** Изолирует ошибки React от окна: остаются сообщение и явное повторное монтирование.
 * Диагностика передаётся владельцу приложения; сама граница не знает транспорт и не повторяет файловые операции.
 */
export class RenderBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, details: ErrorInfo): void {
    this.props.onError?.(error, details);
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">
          <AlertTitle>{shellTexts.renderError}</AlertTitle>
          {this.state.error.message || shellTexts.unknownError}
          <Box sx={{ mt: 2 }}>
            <ActionButton onClick={() => this.setState({ error: null })}>{shellTexts.restartPage}</ActionButton>
          </Box>
        </Alert>
      </Box>
    );
  }
}
