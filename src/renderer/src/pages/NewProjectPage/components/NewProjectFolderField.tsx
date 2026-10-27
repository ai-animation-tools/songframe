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
        label="Полный путь к новой папке"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        sx={{ flex: 1 }}
        helperText="Папка ещё не должна существовать. Она будет заполнена из шаблона; репозиторий Git создаётся, если Git установлен. Без него проект тоже работает"
      />
      <Button variant="outlined" startIcon={<FolderOpenIcon />} onClick={onPickParent} sx={{ mt: 0.25, whiteSpace: 'nowrap' }}>
        Родительская папка
      </Button>
    </Box>
  );
}
