/** Создание типа с автоматическим предложением кода из подписи. */
import type { Dispatch, ReactElement, SetStateAction } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import { suggestId } from '../helpers';
import type { KindForm } from '../types';

interface Props {
  value: KindForm | null;
  onChange: Dispatch<SetStateAction<KindForm | null>>;
  onClose: () => void;
  onAdd: () => void;
}

export function ReferenceKindDialog({ value, onChange, onClose, onAdd }: Props): ReactElement {
  return (
    <Dialog open={!!value} onClose={() => onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>Новый тип референсов</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Подпись"
            value={value?.label ?? ''}
            onChange={(e) => onChange((d) => d && { ...d, label: e.target.value, id: d.id && d.id !== suggestId(d.label) ? d.id : suggestId(e.target.value) })}
            autoFocus
            placeholder="Животное"
          />
          <TextField
            label="Код"
            value={value?.id ?? ''}
            onChange={(e) => onChange((d) => d && { ...d, id: e.target.value })}
            helperText="латиница, цифры, _; станет значением kind"
          />
          <TextField
            label="Папка в source"
            value={value?.dir ?? ''}
            onChange={(e) => onChange((d) => d && { ...d, dir: e.target.value })}
            placeholder={value?.id || 'animals'}
            helperText="Пусто: совпадает с кодом"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlinedIcon />} onClick={() => onClose()}>
          Отмена
        </Button>
        <Button variant="contained" color="success" startIcon={<AddIcon />} onClick={onAdd}>
          Добавить
        </Button>
      </DialogActions>
    </Dialog>
  );
}
