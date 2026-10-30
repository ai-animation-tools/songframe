/** Управляемая витрина предложений: запись материалов и их художественное согласование остаются разными шагами. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { ProductionProposal, ProductionStageProposal } from '@shared/production-workflow';
import { ActionButton } from '../components/ActionButton';
import { ProductionProposalPreview } from '../pages/ProductionPage/components/ProductionProposalPreview';
import { ProductionProposalDialog } from '../pages/ProductionPage/components/ProductionProposalDialog';
import { workflowProposal } from './productionWorkflowStories';

export interface ProposalPreviewStoryProps {
  initialProposal?: ProductionProposal;
  busy?: boolean;
  failFirst?: boolean;
  dialog?: boolean;
  delay?: number;
}

function savedText(value: string | ProductionStageProposal): string {
  if (typeof value === 'string') return value || 'Материалы ещё не сохранены.';
  switch (value.stage) {
    case 'description':
      return value.description;
    case 'prompt':
      return value.prompt;
    case 'frames':
      return `Сохранены кандидаты: ${value.images.map((image) => image.id).join(', ')}. Все требуют отдельного утверждения.`;
    case 'request':
      return `Подготовлен запрос: ${value.request.model}, результатов ${value.request.outputs}. Отправка не выполнялась.`;
  }
}

export function ProposalPreviewStory({ initialProposal, busy = false, failFirst = false, dialog = false, delay = 250 }: ProposalPreviewStoryProps) {
  const [proposal, setProposal] = useState<ProductionProposal | null>(() => structuredClone(initialProposal ?? workflowProposal()));
  const [saved, setSaved] = useState<string | ProductionStageProposal>(() => (initialProposal ?? workflowProposal()).before);
  const [running, setRunning] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; resolve(value: boolean): void } | null>(null);
  const failed = useRef(false);
  useEffect(
    () => () => {
      if (!pending.current) return;
      clearTimeout(pending.current.timer);
      pending.current.resolve(false);
      pending.current = null;
    },
    []
  );
  // Ошибка и отмена не меняют сохранённый снимок; повтор использует то же готовое предложение.
  const run = (action: 'apply' | 'discard'): Promise<boolean> => {
    if (!proposal || busy || pending.current || proposal.status === 'running' || proposal.status === 'applied') return Promise.resolve(false);
    if (action === 'apply' && (proposal.status !== 'ready' || proposal.stale || !proposal.after)) return Promise.resolve(false);
    setRunning(true);
    setNotice(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current = null;
        setRunning(false);
        if (failFirst && !failed.current) {
          failed.current = true;
          setNotice({ error: true, text: 'Не удалось сохранить изменения. Материалы и предложение сохранены для повтора.' });
          resolve(false);
          return;
        }
        if (action === 'discard') {
          setProposal(null);
          setNotice({ error: false, text: 'Предложение отклонено. Сохранённые материалы не изменены.' });
        } else if (proposal.after) {
          setSaved(structuredClone(proposal.after));
          setProposal({ ...proposal, status: 'applied' });
          setNotice({ error: false, text: 'Материалы записаны. Согласование требуется отдельно; генерация и отправка не запускались.' });
        }
        resolve(true);
      }, delay);
      pending.current = { timer, resolve };
    });
  };
  const locked = busy || running;
  return (
    <Stack spacing={2}>
      <Typography variant="caption" color="text.secondary">
        Локальная модель: предложение записывается только после подтверждения. Применение не утверждает описание, опоры или видеопромпт.
      </Typography>
      {notice && !dialog && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
      {running && (
        <Alert severity="info" role="status">
          Сохраняем изменения…
        </Alert>
      )}
      {proposal ? (
        dialog ? (
          <ProductionProposalDialog
            key={epoch}
            proposal={proposal}
            provider="codex"
            busy={locked}
            error={notice?.error ? notice.text : null}
            onApply={() => run('apply')}
            onDiscard={() => run('discard')}
          />
        ) : (
          <ProductionProposalPreview
            key={epoch}
            proposal={proposal}
            provider="codex"
            busy={locked}
            onApply={() => void run('apply')}
            onDiscard={() => void run('discard')}
          />
        )
      ) : (
        <Alert severity="info">Предложения нет.</Alert>
      )}
      {notice && dialog && !notice.error && <Alert severity="success">{notice.text}</Alert>}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2">Сохранённые материалы</Typography>
        <Typography data-testid="saved-materials" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 120, overflowY: 'auto' }}>
          {savedText(saved)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Согласование в этой модели не выполнялось.
        </Typography>
      </Paper>
      <ActionButton
        startIcon={<RestartAltIcon />}
        onClick={() => {
          // Сброс отменяет отложенную запись и размонтирует также галерею, подтверждения и полный диалог.
          if (pending.current) {
            clearTimeout(pending.current.timer);
            pending.current.resolve(false);
            pending.current = null;
          }
          setProposal(structuredClone(initialProposal ?? workflowProposal()));
          setSaved((initialProposal ?? workflowProposal()).before);
          setRunning(false);
          setNotice(null);
          failed.current = false;
          setEpoch((value) => value + 1);
        }}
      >
        Сбросить модель
      </ActionButton>
    </Stack>
  );
}
