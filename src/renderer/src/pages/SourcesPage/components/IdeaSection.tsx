import { sourcesTexts } from '@shared/texts/sources';
/** Свободное описание истории клипа с импортом текста из файла. */
import type { ReactElement } from 'react';
import { Box, Paper, TextField, Typography } from '@mui/material';
import { FileDropZone } from '../../../components/FileDropZone';

interface Props {
  idea: string;
  onChange: (value: string) => void;
  onPick: () => Promise<void>;
  onDrop: (paths: string[]) => Promise<void>;
}

export function IdeaSection({ idea, onChange, onPick, onDrop }: Props): ReactElement {
  // Пустая идея не сохраняется, поэтому поле отмечено так же, как текст песни с ошибкой.
  const missing = !idea.trim();
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        {sourcesTexts.idea}
      </Typography>
      <TextField
        label={sourcesTexts.idea}
        multiline
        minRows={14}
        maxRows={30}
        fullWidth
        sx={{ '& .MuiInputBase-inputMultiline': { lineHeight: 1.6 } }}
        value={idea}
        required
        error={missing}
        helperText={missing ? sourcesTexts.ideaRequired : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={sourcesTexts.ideaPlaceholder}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        {sourcesTexts.ideaHint}
      </Typography>
      {/* Выбор файла не перехватывает нажатия и перетаскивание текста в редакторе. */}
      <Box sx={{ mt: 'auto', pt: 1 }}>
        <FileDropZone
          label={sourcesTexts.uploadIdea}
          kind="text"
          onFiles={onDrop}
          onPick={onPick}
          hint={sourcesTexts.textFileHint}
          message={sourcesTexts.ideaFileMessage}
        />
      </Box>
    </Paper>
  );
}
