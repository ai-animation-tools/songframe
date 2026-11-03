import type { ReactElement } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import type { DerivedShotPreview as Preview } from '@shared/derived-shot';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { ActionButton } from '../../../components/ActionButton';
import { recipeInfo } from '../derivedRecipeForm';
import { LinkedText } from '../../../components/LinkedText';

/** Предпросмотр не заменяет комплект: даже после окончания сборки нужно отдельное явное принятие. */
export function DerivedShotPreview({
  preview,
  hasAsset,
  disabledReason,
  onAccept
}: {
  preview: Preview;
  hasAsset: boolean;
  disabledReason: string | null;
  onAccept(): void;
}): ReactElement {
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle1">{texts.preview}</Typography>
      <Typography variant="body2">{texts.targetFrames({ frames: preview.frames })}</Typography>
      <Typography variant="body2">{recipeInfo(preview.recipe, preview.frames)}</Typography>
      {preview.problem || !preview.fresh ? (
        <Alert severity="warning">
          <LinkedText text={preview.problem ?? texts.stale} />
        </Alert>
      ) : null}
      {preview.accepted ? <Alert severity="success">{texts.alreadyAccepted}</Alert> : null}
      <Box
        component="video"
        key={preview.id}
        controls
        preload="metadata"
        aria-label={texts.previewVideo}
        src={window.api.shell.fileUrl(preview.videoPath)}
        sx={{ width: '100%', maxHeight: 340, borderRadius: 1, bgcolor: 'common.black' }}
      />
      <Box>
        <ActionButton
          variant="contained"
          color={hasAsset ? 'error' : 'primary'}
          startIcon={<CheckIcon />}
          disabled={!!disabledReason}
          disabledReason={disabledReason}
          onClick={onAccept}
        >
          {hasAsset ? texts.replace : texts.accept}
        </ActionButton>
      </Box>
    </Stack>
  );
}
