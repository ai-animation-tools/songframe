import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Avatar, Box, Chip, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { CastEntity, CastProperty, SourceKind } from '@shared/types';
import { StateEditor } from '../../../components';
import { WORLD } from '../constants';
import type { CastImageOption } from '../types';
import { CastEntityIdentityFields } from './CastEntityIdentityFields';
import { CastEntityImages } from './CastEntityImages';

interface CastEntityCardProps {
  entity: CastEntity;
  entities: CastEntity[];
  kinds: SourceKind[];
  properties: CastProperty[];
  imagePaths: Record<string, string>;
  imageOptions: CastImageOption[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onUpdate: (patch: Partial<CastEntity>) => void;
  onRename: (id: string) => void;
  onRemove: () => void;
}

/** Карточка объединяет сведения о сущности, её изображения и редактор начального состояния. */
export function CastEntityCard({
  entity,
  entities,
  kinds,
  properties,
  imagePaths,
  imageOptions,
  expanded,
  onExpandedChange,
  onUpdate,
  onRename,
  onRemove
}: CastEntityCardProps): ReactElement {
  const thumb = entity.images[0] ? window.api.shell.fileUrl(imagePaths[entity.images[0]] ?? '') : undefined;
  const stateCount = Object.keys(entity.initial_state).length;
  return (
    <Accordion
      expanded={expanded}
      onChange={(_e, open) => onExpandedChange(open)}
      disableGutters
      variant="outlined"
      sx={{ minWidth: 0, m: '0 !important', gridColumn: expanded ? '1 / -1' : undefined }}
    >
      {/* Содержимое заголовка может сжиматься внутри колонки, не выталкивая изображение за край карточки. */}
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ '& .MuiAccordionSummary-content': { minWidth: 0 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1, minWidth: 0 }}>
          <Avatar src={thumb} variant="rounded" sx={{ width: 40, height: 40, bgcolor: 'action.hover', color: 'text.secondary', fontSize: 14 }}>
            {entity.kind === WORLD ? '🌍' : entity.name.slice(0, 1)}
          </Avatar>
          <Typography fontWeight={600} noWrap>
            {entity.name || '(без названия)'}
          </Typography>
          <Chip size="small" variant="outlined" label={kinds.find((kind) => kind.id === entity.kind)?.label ?? entity.kind} />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            {entity.id}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {entity.role ? (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 260 }}>
              {entity.role}
            </Typography>
          ) : null}
          <Chip size="small" label={stateCount ? `состояние: ${stateCount}` : 'без состояния'} color={stateCount ? 'default' : 'warning'} variant="outlined" />
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <CastEntityIdentityFields entity={entity} entities={entities} kinds={kinds} onUpdate={onUpdate} onRename={onRename} />
          <TextField
            label="Роль в сюжете"
            value={entity.role}
            onChange={(e) => onUpdate({ role: e.target.value })}
            placeholder="главный герой и рассказчик; самоуверенный водитель"
          />
          <TextField
            label="Внешность и неизменные правила"
            multiline
            minRows={2}
            value={entity.appearance}
            onChange={(e) => onUpdate({ appearance: e.target.value })}
            placeholder={entity.kind === WORLD ? 'Общие условия клипа, которые не меняются' : 'Только то, что видно на референсах и следует из идеи'}
          />
          {entity.kind !== WORLD ? (
            <CastEntityImages images={entity.images} imagePaths={imagePaths} imageOptions={imageOptions} onChange={(images) => onUpdate({ images })} />
          ) : null}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Начальное состояние (до первого события сюжета)
            </Typography>
            <StateEditor
              properties={properties}
              value={entity.initial_state}
              onChange={(next) => onUpdate({ initial_state: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null)) as Record<string, string> })}
            />
          </Box>
          <Box>
            <DestructiveButton
              label={`Удалить сущность «${entity.name || entity.id}»`}
              description="Сущность и её настройки будут удалены из состава проекта."
              disabled={entity.kind === WORLD}
              onConfirm={onRemove}
              startIcon={<DeleteOutlineIcon />}
            />
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
