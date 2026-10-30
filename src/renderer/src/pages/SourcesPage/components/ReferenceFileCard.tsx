import { sourcesTexts } from '@shared/texts/sources';
/** Изображение, описание и его собственный промпт образуют одну строку, чтобы виды не смешивались. */
import type { ReactElement } from 'react';
import { Box, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { REFERENCE_VIEW_LABELS, type ReferenceView } from '@shared/types';
import type { FileForm } from '../types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ReferencePromptError } from './ReferencePromptError';

interface Props {
  file: FileForm;
  referenceName: string;
  fileUrl: (path: string, absolute?: boolean) => string;
  onUpdate: (patch: Partial<FileForm>) => void;
  onRemove: () => void;
  onRetryPrompt: () => Promise<void>;
}

export function ReferenceFileCard({ file, referenceName, fileUrl, onUpdate, onRemove, onRetryPrompt }: Props): ReactElement {
  const src = file.sourcePath ? fileUrl(file.sourcePath, true) : fileUrl(file.existingPath!);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, containerType: 'inline-size', containerName: 'reference-file' }}>
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          alignItems: 'start',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container reference-file (min-width: 620px)': { gridTemplateColumns: '170px minmax(0, 1fr) minmax(0, 1fr)' },
          '& > *': { minWidth: 0 }
        }}
      >
        <Box sx={{ position: 'relative' }}>
          <img
            src={src}
            alt={sourcesTexts.referenceImageAlt({ name: referenceName, view: REFERENCE_VIEW_LABELS[file.view] })}
            style={{ width: '100%', height: 150, objectFit: 'contain', borderRadius: 6, display: 'block' }}
          />
          <DestructiveButton
            icon
            label={sourcesTexts.removeReferenceImage({ view: REFERENCE_VIEW_LABELS[file.view] })}
            description={file.sourcePath ? sourcesTexts.removeNewReferenceImage : sourcesTexts.removeSavedReferenceImage}
            onConfirm={onRemove}
            sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'background.paper' }}
          >
            <CloseIcon fontSize="inherit" />
          </DestructiveButton>
          <TextField
            select
            fullWidth
            label={sourcesTexts.view}
            value={file.view}
            onChange={(e) => onUpdate({ view: e.target.value as ReferenceView })}
            sx={{ mt: 1 }}
          >
            {(Object.keys(REFERENCE_VIEW_LABELS) as ReferenceView[]).map((v) => (
              <MenuItem key={v} value={v}>
                {REFERENCE_VIEW_LABELS[v]}
              </MenuItem>
            ))}
          </TextField>
          {file.sourcePath ? (
            <Typography variant="caption" color="primary" display="block" noWrap title={file.sourcePath} sx={{ mt: 0.5 }}>
              {sourcesTexts.newFile}
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary" display="block" noWrap sx={{ mt: 0.5 }}>
              {file.existingPath}
            </Typography>
          )}
        </Box>
        <TextField
          fullWidth
          multiline
          minRows={7}
          maxRows={14}
          label={sourcesTexts.imageDescription}
          value={file.note}
          onChange={(e) => onUpdate({ note: e.target.value })}
          placeholder={sourcesTexts.imageDescriptionPlaceholder}
        />
        <Stack spacing={1}>
          {file.promptError ? <ReferencePromptError error={file.promptError} onRetry={onRetryPrompt} /> : null}
          <TextField
            fullWidth
            multiline
            minRows={7}
            maxRows={14}
            label={sourcesTexts.imagePrompt}
            value={file.prompt}
            onChange={(e) => onUpdate({ prompt: e.target.value })}
            placeholder={sourcesTexts.imagePromptPlaceholder}
          />
        </Stack>
      </Box>
    </Paper>
  );
}
