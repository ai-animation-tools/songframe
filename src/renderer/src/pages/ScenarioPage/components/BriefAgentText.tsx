import { type ReactElement, useId, useState } from 'react';
import { Box, Button, Collapse, Typography } from '@mui/material';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/** Свёрнутые абзацы врезки в том виде, в каком приложение вкладывает их в промпт опор. */
export function BriefAgentText({ before, after }: { before: string; after: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Button
        size="small"
        startIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        Текст для агента
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box id={id} sx={{ mt: 1, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
            Эти абзацы идут в промпт опор дословно; копировать их не нужно.
          </Typography>
          {[before, after].map((paragraph, index) => (
            <Typography key={index} variant="body2" sx={{ overflowWrap: 'anywhere', mt: index ? 1 : 0 }}>
              {paragraph}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
