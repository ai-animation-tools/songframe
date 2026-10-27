/** Предпросмотр, выбор и удаление необязательной обложки. */
import type { ReactElement } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { FileDropZone } from '../../../components/FileDropZone';
import { AgentButton } from '../../../components/AgentButton';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';

interface Props {
  coverSrc: string | null;
  onPick: () => Promise<void>;
  onRemove: () => void;
  onDrop: (paths: string[]) => void;
  onGenerate: () => void;
}

export function CoverSection({ coverSrc, onPick, onRemove, onDrop, onGenerate }: Props): ReactElement {
  const { agentProvider, aiAccess } = useApp();
  const blockedReason = !agentProvider ? COVER_AGENT_REQUIRED : aiActionProblem(aiAccess, 'image');
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Обложка{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (необязательно)
        </Typography>
      </Typography>
      {coverSrc ? (
        <Box sx={{ mb: 1, position: 'relative', width: 120 }}>
          <img src={coverSrc} alt="Обложка" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
          {/* Удаление расположено на изображении так же, как у файлов референса. */}
          <DestructiveButton
            icon
            label="Убрать обложку"
            description="Обложка будет убрана из исходников. После сохранения ранее сохранённый файл обложки также будет удалён из проекта."
            onConfirm={onRemove}
            confirmLabel="Убрать"
            sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'background.paper' }}
          >
            <CloseIcon fontSize="inherit" />
          </DestructiveButton>
        </Box>
      ) : null}
      {/* Отдельная область не перехватывает действие удаления и подтверждение. */}
      <FileDropZone
        label="Загрузка обложки"
        kind="image"
        onFiles={onDrop}
        onPick={onPick}
        hint="Одно изображение PNG, JPG или WebP."
        message="Перетащите изображение или нажмите для выбора"
      />
      <Box sx={{ mt: 1 }}>
        <AgentButton
          onClick={onGenerate}
          aiKind="image"
          disabled={Boolean(blockedReason)}
          title={blockedReason ?? 'Создать обложку через провайдера изображений проекта'}
        >
          Сгенерировать
        </AgentButton>
        {blockedReason ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {blockedReason}
          </Typography>
        ) : null}
      </Box>
    </Paper>
  );
}
