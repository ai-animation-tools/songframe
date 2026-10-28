/** Повтор всегда создаёт новое задание по заново введённому запросу, без скрытого возобновления сессии. */
import { useState, type ReactElement } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import { aiActionProblem } from '@shared/ai-access';
import type { AgentJob } from '@shared/agents';
import { useApp } from '../state';
import { AgentButton } from './AgentButton';
import { AgentIcon } from './AgentIcon';

export function AgentRetryDialog({ job, onClose }: { job: AgentJob; onClose(): void }): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { describeError, agentProvider, aiAccess } = useApp();
  const aiProblem = aiActionProblem(aiAccess);
  const submit = async (): Promise<void> => {
    if (aiProblem) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.agents.start({ project: job.project, task: job.task, prompt, context, retryOf: job.id });
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {agentProvider ? <AgentIcon provider={agentProvider} /> : null}
        Повторить задание
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>{job.task}</Typography>
          <Typography variant="body2" color="text.secondary">
            Предыдущий запрос не сохраняется. Введите его заново: будет создано отдельное задание с текущими настройками агента. Агент подготовит предложение
            без изменения файлов проекта.
          </Typography>
          <TextField
            label="Запрос"
            multiline
            minRows={4}
            autoFocus
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy}
          />
          <TextField
            label="Дополнительный контекст"
            multiline
            minRows={2}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            disabled={busy}
          />
          {aiProblem && <Alert severity="info">{aiProblem}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlinedIcon />} onClick={onClose} disabled={busy}>
          Отмена
        </Button>
        <AgentButton variant="contained" onClick={submit} disabled={busy || !prompt.trim()}>
          {busy ? 'Запуск' : 'Запустить'}
        </AgentButton>
      </DialogActions>
    </Dialog>
  );
}
