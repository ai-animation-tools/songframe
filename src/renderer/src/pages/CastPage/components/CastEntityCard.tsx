import { castTexts } from '@shared/texts/cast';
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Avatar, Box, Chip, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { CastEntity, CastProperty, SourceKind } from '@shared/types';
import { ReferenceImageGenerateButton } from '../../../components/ReferenceImageGenerateButton';
import { AiProblemAlert } from '../../../components/AiProblemAlert';
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
  onGenerate: () => void;
  generationDisabledReason?: string | null;
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
  onRemove,
  onGenerate,
  generationDisabledReason
}: CastEntityCardProps): ReactElement {
  const thumb = entity.images[0] ? window.api.shell.fileUrl(imagePaths[entity.images[0]] ?? '') : undefined;
  const stateCount = Object.keys(entity.initial_state).length;
  return (
    <Accordion
      expanded={expanded}
      onChange={(_e, open) => onExpandedChange(open)}
      disableGutters
      variant="outlined"
      // По этой метке «Кастинг» прокручивает к карточке при переходе с ?entity=.
      data-cast-entity={entity.id}
      // Свёрнутое содержимое не держим в DOM: скрытые поля и кнопки не попадают в обход и проверки доступности.
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ minWidth: 0, m: '0 !important', gridColumn: expanded ? '1 / -1' : undefined }}
    >
      {/* Содержимое заголовка может сжиматься внутри колонки, не выталкивая изображение за край карточки. */}
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ '& .MuiAccordionSummary-content': { minWidth: 0 } }}>
        {/* На узкой рабочей области сведения занимают три строки: длинное имя и код не вытесняют статус и стрелку за рамку карточки. */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: '40px minmax(0, 1fr) auto',
            gridTemplateAreas: '"avatar name kind" "avatar id state" "avatar role state"',
            '@container workspace (min-width: 900px)': {
              gridTemplateColumns: '40px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2fr) auto',
              gridTemplateAreas: '"avatar name kind id role state"'
            },
            alignItems: 'center',
            columnGap: 1.5,
            rowGap: 0.5,
            flex: 1,
            minWidth: 0
          }}
        >
          <Avatar
            src={thumb}
            variant="rounded"
            sx={{ gridArea: 'avatar', width: 40, height: 40, bgcolor: 'action.hover', color: 'text.secondary', fontSize: 14 }}
          >
            {entity.kind === WORLD ? '🌍' : entity.name.slice(0, 1)}
          </Avatar>
          <Typography fontWeight={600} noWrap title={entity.name || undefined} sx={{ gridArea: 'name', minWidth: 0 }}>
            {entity.name || castTexts.unnamedEntity}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={kinds.find((kind) => kind.id === entity.kind)?.label ?? entity.kind}
            sx={{ gridArea: 'kind', minWidth: 0, maxWidth: 160 }}
          />
          <Typography variant="caption" color="text.secondary" noWrap title={entity.id} sx={{ gridArea: 'id', fontFamily: 'monospace', minWidth: 0 }}>
            {entity.id}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap title={entity.role || undefined} sx={{ gridArea: 'role', minWidth: 0 }}>
            {entity.role}
          </Typography>
          <Chip
            size="small"
            label={stateCount ? castTexts.stateCount({ count: stateCount }) : castTexts.noState}
            color={stateCount ? 'default' : 'warning'}
            variant="outlined"
            sx={{ gridArea: 'state', minWidth: 0 }}
          />
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <CastEntityIdentityFields entity={entity} entities={entities} kinds={kinds} onUpdate={onUpdate} onRename={onRename} />
          <TextField label={castTexts.role} value={entity.role} onChange={(e) => onUpdate({ role: e.target.value })} placeholder={castTexts.rolePlaceholder} />
          <TextField
            label={castTexts.appearance}
            multiline
            minRows={2}
            value={entity.appearance}
            onChange={(e) => onUpdate({ appearance: e.target.value })}
            placeholder={entity.kind === WORLD ? castTexts.worldAppearancePlaceholder : castTexts.appearancePlaceholder}
          />
          <CastEntityImages images={entity.images} imagePaths={imagePaths} imageOptions={imageOptions} onChange={(images) => onUpdate({ images })} />
          <AiProblemAlert kinds={['image']} />
          <Box>
            <ReferenceImageGenerateButton onClick={onGenerate} disabledReason={generationDisabledReason} />
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              {castTexts.initialState}
            </Typography>
            <StateEditor
              properties={properties}
              value={entity.initial_state}
              onChange={(next) => onUpdate({ initial_state: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null)) as Record<string, string> })}
            />
          </Box>
          <Box>
            {/* Мир сцены обязателен для состояния сцены: выключенная кнопка объясняет причину. */}
            <DestructiveButton
              label={castTexts.removeEntity({ name: entity.name || entity.id })}
              description={castTexts.removeEntityDescription}
              disabled={entity.kind === WORLD}
              disabledReason={castTexts.worldCannotBeRemoved}
              onConfirm={onRemove}
              startIcon={<DeleteOutlineIcon />}
            />
          </Box>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
