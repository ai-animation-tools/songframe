/** Текст песни и сообщения об обязательном формате строк и секций. */
import type { ReactElement } from 'react';
import { Box, Paper, TextField, Typography } from '@mui/material';
import { type analyzeLyrics, LYRICS_FORMAT_HINT } from '@shared/lyrics';
import { FileDropZone } from '../../../components/FileDropZone';

interface Props {
  lyrics: string;
  lyricsCheck: ReturnType<typeof analyzeLyrics>;
  onChange: (value: string) => void;
  onPick: () => Promise<void>;
  onDrop: (paths: string[]) => Promise<void>;
}

export function LyricsSection({ lyrics, lyricsCheck, onChange, onPick, onDrop }: Props): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Текст песни
      </Typography>
      <TextField
        multiline
        minRows={14}
        maxRows={30}
        fullWidth
        label="Текст песни"
        value={lyrics}
        error={lyricsCheck.problems.length > 0}
        helperText={lyricsCheck.problems.length ? lyricsCheck.problems.join(' ') : LYRICS_FORMAT_HINT}
        sx={{ '& .MuiInputBase-inputMultiline': { lineHeight: 1.6 } }}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'[Куплет 1]\nпервая строка\nвторая строка\n\n[Припев]\n…'}
      />
      {/* Статистика отделена от подсказки поля, чтобы пояснения не сливались в один абзац. */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        Сейчас: {lyricsCheck.lines} строк песни, секций: {lyricsCheck.sections.length}. Пустые строки между секциями необязательны. Файл — TXT или MD в UTF-8,
        без Markdown-заголовков и списков. Текст должен совпадать с исполнением.
      </Typography>
      {/* Выбор файла не перехватывает нажатия и перетаскивание текста в редакторе. */}
      <Box sx={{ mt: 'auto', pt: 1 }}>
        <FileDropZone
          label="Загрузить текст песни из файла"
          kind="text"
          onFiles={onDrop}
          onPick={onPick}
          hint="Один файл TXT или MD в UTF-8."
          message="Перетащите файл с текстом песни или нажмите для выбора"
        />
      </Box>
    </Paper>
  );
}
