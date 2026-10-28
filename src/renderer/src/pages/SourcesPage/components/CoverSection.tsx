/** Предпросмотр, выбор и удаление необязательной обложки. */
import type { ReactElement } from 'react';
import { Box, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { FileDropZone } from '../../../components/FileDropZone';
import { AgentButton } from '../../../components/AgentButton';
import { AiProblemAlert } from '../../../components/AiProblemAlert';

interface Props {
  coverSrc: string | null;
  onPick: () => Promise<void>;
  onRemove: () => void;
  onDrop: (paths: string[]) => void;
  onGenerate: () => void;
}

export function CoverSection({ coverSrc, onPick, onRemove, onDrop, onGenerate }: Props): ReactElement {
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
      {/* Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет, AgentButton сам блокируется по той же причине. */}
      <Stack spacing={1} sx={{ mt: 1 }}>
        <AiProblemAlert kinds={['image']} />
        <Box>
          <AgentButton onClick={onGenerate} aiKind="image" title="Создать обложку через провайдера изображений проекта">
            Сгенерировать обложку
          </AgentButton>
        </Box>
      </Stack>
    </Paper>
  );
}
