/** Типы референсов проекта и управление их набором. */
import type { ReactElement } from 'react';
import { Box, Button, Chip, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { SourceKind } from '@shared/types';

interface Props {
  kinds: SourceKind[];
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export function ReferenceKinds({ kinds, onRemove, onAdd }: Props): ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
      <Typography variant="caption" color="text.secondary">
        Типы:
      </Typography>
      {/* Удаление вынесено из Chip: отдельная кнопка показывает опасный цвет и открывает подтверждение. */}
      {kinds.map((kind) => (
        <Box key={kind.id} sx={{ display: 'inline-flex', alignItems: 'center' }}>
          <Chip size="small" label={`${kind.label} · ${kind.dir}/`} />
          <DestructiveButton
            icon
            label={`Удалить тип «${kind.label}»`}
            description="Тип будет удалён из списка типов референсов. Используемый референсами тип удалить нельзя."
            onConfirm={() => onRemove(kind.id)}
          >
            <DeleteOutlineIcon fontSize="small" />
          </DestructiveButton>
        </Box>
      ))}
      <Button size="small" color="success" startIcon={<AddIcon />} onClick={onAdd}>
        Добавить тип
      </Button>
    </Box>
  );
}
