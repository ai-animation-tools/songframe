import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
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
        {sourcesTexts.cover}{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          {sourcesTexts.optional}
        </Typography>
      </Typography>
      {coverSrc ? (
        <Box sx={{ mb: 1, position: 'relative', width: 120 }}>
          <img src={coverSrc} alt={sourcesTexts.cover} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
          {/* Удаление расположено на изображении так же, как у файлов референса. */}
          <DestructiveButton
            icon
            label={sourcesTexts.removeCover}
            description={sourcesTexts.removeCoverDescription}
            onConfirm={onRemove}
            confirmLabel={commonTexts.remove}
            sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'background.paper' }}
          >
            <CloseIcon fontSize="inherit" />
          </DestructiveButton>
        </Box>
      ) : null}
      {/* Отдельная область не перехватывает действие удаления и подтверждение. */}
      <FileDropZone
        label={sourcesTexts.uploadCover}
        kind="image"
        onFiles={onDrop}
        onPick={onPick}
        hint={sourcesTexts.coverFileHint}
        message={sourcesTexts.coverFileMessage}
      />
      {/* Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет, AgentButton сам блокируется по той же причине. */}
      <Stack spacing={1} sx={{ mt: 1 }}>
        <AiProblemAlert kinds={['image']} />
        <Box>
          <AgentButton onClick={onGenerate} aiKind="image" title={sourcesTexts.generateCoverTitle}>
            {sourcesTexts.generateCover}
          </AgentButton>
        </Box>
      </Stack>
    </Paper>
  );
}
