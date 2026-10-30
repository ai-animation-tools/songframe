import { projectsTexts } from '@shared/texts/projects';
import type { ReactElement } from 'react';
import { Box, Button, TextField } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

interface NewProjectFolderFieldProps {
  value: string;
  onChange: (value: string) => void;
  onPickParent: () => Promise<void>;
}

/** Пользователь задаёт новую папку вручную либо выбирает её родительский каталог. */
export function NewProjectFolderField({ value, onChange, onPickParent }: NewProjectFolderFieldProps): ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <TextField
        label={projectsTexts.folderPath}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        sx={{ flex: 1 }}
        helperText={projectsTexts.folderHelp}
      />
      <Button variant="outlined" startIcon={<FolderOpenIcon />} onClick={onPickParent} sx={{ mt: 0.25, whiteSpace: 'nowrap' }}>
        {projectsTexts.parentFolder}
      </Button>
    </Box>
  );
}
