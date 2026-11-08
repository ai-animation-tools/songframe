import { productionTexts } from '@shared/texts/production';
/** Охват замечания к опоре: по умолчанию оно учитывается и при создании следующих опор пакета. */
import type { ReactElement } from 'react';
import { Checkbox, FormControlLabel, FormHelperText, Box } from '@mui/material';
import type { KeyframeNoteScope } from '@shared/types';

export function KeyframeNoteScopeField({
  scope,
  onChange,
  disabled = false
}: {
  scope: KeyframeNoteScope;
  onChange(scope: KeyframeNoteScope): void;
  disabled?: boolean;
}): ReactElement {
  return (
    <Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={scope === 'following'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked ? 'following' : 'frame')}
          />
        }
        label={productionTexts.keyframeNoteScopeField.following}
      />
      <FormHelperText sx={{ mt: 0 }}>
        {scope === 'following' ? productionTexts.keyframeNoteScopeField.followingHint : productionTexts.keyframeNoteScopeField.singleHint}
      </FormHelperText>
    </Box>
  );
}
