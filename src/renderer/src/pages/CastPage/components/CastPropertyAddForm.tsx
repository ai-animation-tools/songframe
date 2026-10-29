import { type ReactElement, useState } from 'react';
import { Box, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { ActionButton } from '../../../components/ActionButton';
import { propertyKeyProblem } from '../properties';

interface CastPropertyAddFormProps {
  /** Коды свойств выбранного типа: дубль запрещён. */
  existingKeys: string[];
  onAdd: (key: string, label: string) => void;
}

/** Добавление свойства в словарь типа: код и подпись обязательны, остальные поля заполняются в раскрытой строке. */
export function CastPropertyAddForm({ existingKeys, onAdd }: CastPropertyAddFormProps): ReactElement {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const keyProblem = propertyKeyProblem(key, existingKeys);
  const problem = keyProblem ?? (label.trim() ? null : 'Введите подпись свойства.');
  // Ошибку кода показываем после начала ввода, чтобы пустая форма не выглядела ошибочной.
  const keyError = Boolean(key) && Boolean(keyProblem);
  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (problem) return;
        onAdd(key, label.trim());
        setKey('');
        setLabel('');
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        '@container workspace (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
        gap: 1.5,
        alignItems: 'start'
      }}
    >
      <TextField
        size="small"
        label="Код нового свойства"
        required
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="например, helmet"
        error={keyError}
        helperText={
          keyError ? keyProblem : 'Латиницей: a–z, цифры и «_». Под ним значение хранится в состоянии сущностей и планов; после сохранения не меняется.'
        }
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' } } }}
      />
      <TextField
        size="small"
        label="Подпись"
        required
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="например, Шлем"
        helperText="Название поля в редакторах состояния."
        slotProps={{ inputLabel: { shrink: true } }}
      />
      {/* Действие блока — внизу слева, после полей. */}
      <Box sx={{ gridColumn: '1 / -1' }}>
        <ActionButton type="submit" variant="outlined" color="success" startIcon={<AddIcon />} disabled={Boolean(problem)} disabledReason={problem}>
          Добавить свойство
        </ActionButton>
      </Box>
    </Box>
  );
}
