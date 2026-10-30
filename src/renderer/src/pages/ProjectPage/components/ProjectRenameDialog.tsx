import { projectTexts } from '@shared/texts/project';
import { commonTexts } from '@shared/texts/common';
/** Отдельное переименование не требует заполнения настроек генерации. */
import { useState, type ReactElement } from 'react';
import { Alert, Box, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import SaveIcon from '@mui/icons-material/Save';
import { ActionButton } from '../../../components';
import { useApp } from '../../../state';

interface Props {
  project: string;
  name: string;
  onClose(): void;
}

export function ProjectRenameDialog({ project, name, onClose }: Props): ReactElement {
  const { refresh, notify, describeError } = useApp();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.api.projects.rename(project, value);
      await refresh();
      notify(projectTexts.rename.done, 'success');
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim() && value.trim() !== name) void save();
        }}
      >
        <DialogTitle>{projectTexts.rename.title}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            required
            fullWidth
            label={projectTexts.rename.name}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            sx={{ mt: 1 }}
            helperText={projectTexts.rename.help}
          />
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <ActionButton startIcon={<CancelOutlinedIcon />} onClick={onClose} disabled={busy} disabledReason={projectTexts.rename.wait}>
            {commonTexts.cancel}
          </ActionButton>
          <ActionButton
            type="submit"
            startIcon={<SaveIcon />}
            variant="contained"
            disabled={busy || !value.trim() || value.trim() === name}
            disabledReason={busy ? projectTexts.rename.wait : !value.trim() ? projectTexts.rename.nameRequired : projectTexts.rename.nameUnchanged}
          >
            {busy ? commonTexts.saving : commonTexts.save}
          </ActionButton>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
