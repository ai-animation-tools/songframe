import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Box, MenuItem, TextField } from '@mui/material';
import type { CastEntity, SourceKind } from '@shared/types';
import { WORLD } from '../constants';

interface CastEntityIdentityFieldsProps {
  entity: CastEntity;
  entities: CastEntity[];
  kinds: SourceKind[];
  onUpdate: (patch: Partial<CastEntity>) => void;
  onRename: (id: string) => void;
}

/** Поля идентификации сохраняют ограничения на изменение и удаление мира сцены. */
export function CastEntityIdentityFields({ entity, entities, kinds, onUpdate, onRename }: CastEntityIdentityFieldsProps): ReactElement {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: '2fr 1fr 1.2fr 1fr' }, gap: 1.5, alignItems: 'start' }}>
      <TextField label={commonTexts.title} value={entity.name} onChange={(e) => onUpdate({ name: e.target.value })} />
      <TextField label={castTexts.shortName} value={entity.short_name} onChange={(e) => onUpdate({ short_name: e.target.value })} placeholder={entity.name} />
      <TextField select label={commonTexts.type} value={entity.kind} onChange={(e) => onUpdate({ kind: e.target.value })} disabled={entity.kind === WORLD}>
        {kinds.map((k) => (
          <MenuItem key={k.id} value={k.id} disabled={k.id === WORLD && entities.some((e) => e.kind === WORLD && e.id !== entity.id)}>
            {k.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={commonTexts.code}
        value={entity.id}
        onChange={(e) => onRename(e.target.value)}
        helperText={castTexts.entityCodeKey}
        disabled={entity.kind === WORLD}
      />
    </Box>
  );
}
