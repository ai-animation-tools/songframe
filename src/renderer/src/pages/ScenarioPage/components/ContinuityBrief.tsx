import type { ReactElement } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { ScenarioBrief } from '../types';
import { BriefPhase } from './BriefPhase';

/** Показывает вычисленную врезку непрерывности и копирует абзац для промпта. */
export function ContinuityBrief({ brief, copy }: { brief: ScenarioBrief; copy(text: string): Promise<void> }): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0, overflowWrap: 'anywhere' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1, minWidth: 0 }}>
          Врезка непрерывности
        </Typography>
      </Box>
      {brief ? (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Сравните первый и последний кадры плана с пунктами ниже. Отметки действуют только в текущей проверке, не сохраняются и не утверждают сцену.
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 2, minWidth: 0 }}>
            {/* Новое содержимое или другой план начинают отдельную проверку без прежних отметок. */}
            <BriefPhase key={JSON.stringify(brief.before)} brief={brief.before} />
            <BriefPhase key={JSON.stringify(brief.after)} brief={brief.after} />
          </Box>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Врезка появится, когда реестр пройдёт проверку.
        </Typography>
      )}
      {brief && (
        <Button sx={{ mt: 1 }} size="small" startIcon={<ContentCopyIcon />} onClick={() => copy(brief.before.paragraph)}>
          Скопировать абзац для промпта
        </Button>
      )}
    </Paper>
  );
}
