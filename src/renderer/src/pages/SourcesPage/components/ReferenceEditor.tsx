/** Сворачиваемая сущность объединяет общие правила и отдельные строки её изображений. */
import { useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { ReferenceKind, SourceKind } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { suggestId } from '../helpers';
import type { FileForm, ReferenceForm } from '../types';
import { ReferenceFileCard } from './ReferenceFileCard';
import { FileDropZone } from '../../../components/FileDropZone';

interface Props {
  reference: ReferenceForm;
  kinds: SourceKind[];
  fileUrl: (path: string, absolute?: boolean) => string;
  onUpdate: (patch: Partial<ReferenceForm>) => void;
  onRetryFilePrompt: (fileKey: number) => Promise<void>;
  onRemove: () => void;
  onAddFiles: () => Promise<void>;
  onDropFiles: (paths: string[]) => void;
  onUpdateFile: (key: number, patch: Partial<FileForm>) => void;
  onRemoveFile: (key: number) => void;
}

export function ReferenceEditor({
  reference,
  kinds,
  fileUrl,
  onUpdate,
  onRetryFilePrompt,
  onRemove,
  onAddFiles,
  onDropFiles,
  onUpdateFile,
  onRemoveFile
}: Props): ReactElement {
  const [expanded, setExpanded] = useState(!reference.files.length);
  const kind = kinds.find((item) => item.id === reference.kind)?.label ?? reference.kind;
  return (
    <Accordion variant="outlined" disableGutters expanded={expanded} onChange={(_event, value) => setExpanded(value)} sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} id={`reference-${reference.key}-summary`} aria-controls={`reference-${reference.key}-details`}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap', minWidth: 0 }}>
          <Typography component="span" fontWeight={600}>
            {reference.name || 'Новый референс'}
          </Typography>
          <Typography component="span" variant="caption" color="text.secondary">
            {kind} · изображений: {reference.files.length}
          </Typography>
          {reference.promptError || reference.files.some((file) => file.promptError) ? (
            <Typography component="span" variant="caption" color="warning.main">
              Ошибка чтения промпта
            </Typography>
          ) : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails id={`reference-${reference.key}-details`}>
        <Stack spacing={2}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))',
              gap: 1.5,
              alignItems: 'start'
            }}
          >
            <TextField
              label="Название"
              value={reference.name}
              onChange={(e) =>
                onUpdate({ name: e.target.value, id: reference.id && reference.id !== suggestId(reference.name) ? reference.id : suggestId(e.target.value) })
              }
            />
            <TextField label="Код (id)" value={reference.id} onChange={(e) => onUpdate({ id: e.target.value })} helperText="латиница, цифры, _" />
            <TextField
              select
              label="Тип"
              value={kinds.some((item) => item.id === reference.kind) ? reference.kind : ''}
              onChange={(e) => onUpdate({ kind: e.target.value as ReferenceKind })}
            >
              {kinds.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Короткая подпись"
              value={reference.short_name}
              onChange={(e) => onUpdate({ short_name: e.target.value })}
              placeholder={reference.name}
            />
          </Box>
          <TextField
            label="Общее описание сущности"
            fullWidth
            multiline
            minRows={2}
            maxRows={8}
            value={reference.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder="Внешность и правила, общие для всех изображений"
          />
          {reference.files.map((file) => (
            <ReferenceFileCard
              key={file.key}
              file={file}
              referenceName={reference.name}
              fileUrl={fileUrl}
              onUpdate={(patch) => onUpdateFile(file.key, patch)}
              onRemove={() => onRemoveFile(file.key)}
              onRetryPrompt={() => onRetryFilePrompt(file.key)}
            />
          ))}
          <FileDropZone
            label={`Выбрать изображения референса ${reference.name || 'без названия'}`}
            kind="image"
            multiple
            onFiles={onDropFiles}
            onPick={onAddFiles}
            hint="PNG, JPG, WebP. Можно выбрать несколько файлов."
            message="Перетащите изображения или нажмите для выбора"
          />
          <DestructiveButton
            label={`Удалить референс «${reference.name || 'без названия'}»`}
            description="Референс будет удалён вместе с изображениями, описаниями и промптами. После сохранения исходников сохранённые в проекте файлы этого референса также будут удалены."
            onConfirm={onRemove}
            startIcon={<DeleteOutlineIcon />}
          />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
