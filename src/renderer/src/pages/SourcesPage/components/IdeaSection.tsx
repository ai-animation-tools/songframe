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
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Идея клипа
      </Typography>
      <TextField
        label="Идея клипа"
        multiline
        minRows={14}
        maxRows={30}
        fullWidth
        sx={{ '& .MuiInputBase-inputMultiline': { lineHeight: 1.6 } }}
        value={idea}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Общая история прозой: кто герои, что с ними происходит, настроение, без привязки к таймингам."
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        Сохраняется в source/description.md. Сценарий по сценам составляется позже, из этого текста, слов песни и разметки.
      </Typography>
      {/* Выбор файла не перехватывает нажатия и перетаскивание текста в редакторе. */}
      <Box sx={{ mt: 'auto', pt: 1 }}>
        <FileDropZone
          label="Загрузить идею клипа из файла"
          kind="text"
          onFiles={onDrop}
          onPick={onPick}
          hint="Один файл TXT или MD в UTF-8."
          message="Перетащите файл с идеей или нажмите для выбора"
        />
      </Box>
    </Paper>
  );
}
