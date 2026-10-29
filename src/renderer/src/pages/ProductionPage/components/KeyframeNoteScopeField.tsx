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
        label="Учесть и для следующих опор"
      />
      <FormHelperText sx={{ mt: 0 }}>
        {scope === 'following'
          ? 'Замечание передаётся агенту при создании этой опоры и всех следующих опор пакета.'
          : 'Замечание передаётся агенту только при повторном создании этой опоры.'}
      </FormHelperText>
    </Box>
  );
}
