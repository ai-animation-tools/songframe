import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
/** Сворачиваемая сущность объединяет общие правила и отдельные строки её изображений. */
import { useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { ReferenceKind, SourceKind } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ID_PATTERN, kindChangeNotice, suggestId } from '../helpers';
import type { FileForm, ReferenceForm } from '../types';
import { ImageGallery } from '../../../components/ImageGallery';
import { REFERENCE_VIEW_LABELS } from '@shared/types';
import { ReferenceFileCard } from './ReferenceFileCard';
import { ReferenceImageGenerateButton } from '../../../components/ReferenceImageGenerateButton';
import { AiProblemAlert } from '../../../components/AiProblemAlert';
import { FileDropZone } from '../../../components/FileDropZone';
import { LinkedText } from '../../../components/LinkedText';

interface Props {
  reference: ReferenceForm;
  kinds: SourceKind[];
  /** Планы с готовыми материалами, которые используют референс; undefined — не закреплён. */
  pinnedShots?: string[];
  duplicateId: boolean;
  filePath: (path: string, absolute?: boolean) => string;
  removalProblem?: string;
  removalPending?: boolean;
  fileUrl: (path: string, absolute?: boolean) => string;
  onUpdate: (patch: Partial<ReferenceForm>) => void;
  onRetryFilePrompt: (fileKey: number) => Promise<void>;
  onRemove: () => void;
  onGenerate: () => void;
  onAddFiles: () => Promise<void>;
  onDropFiles: (paths: string[]) => void;
  onUpdateFile: (key: number, patch: Partial<FileForm>) => void;
  onRemoveFile: (key: number) => void;
}

export function ReferenceEditor({
  reference,
  kinds,
  pinnedShots,
  duplicateId,
  fileUrl,
  filePath,
  removalProblem,
  removalPending,
  onUpdate,
  onRetryFilePrompt,
  onRemove,
  onGenerate,
  onAddFiles,
  onDropFiles,
  onUpdateFile,
  onRemoveFile
}: Props): ReactElement {
  const [previewKey, setPreviewKey] = useState<number | null>(null);
  const previewIndex = reference.files.findIndex((file) => file.key === previewKey);
  const [expanded, setExpanded] = useState(!reference.files.length);
  const kind = kinds.find((item) => item.id === reference.kind)?.label ?? reference.kind;
  // Те же правила, что у проверки сохранения: ошибка видна у поля, а не только в общем списке в начале страницы.
  const nameError = reference.name.trim() ? null : sourcesTexts.nameRequired;
  const idError = !ID_PATTERN.test(reference.id) ? sourcesTexts.referenceIdInvalid : duplicateId ? sourcesTexts.duplicateReferenceId : null;
  const kindError = kinds.some((item) => item.id === reference.kind) ? null : sourcesTexts.kindRequired;
  const filesError = reference.files.length ? null : sourcesTexts.imageRequired;
  const hasErrors = Boolean(nameError || idError || kindError || filesError);
  // Смена типа переносит сохранённые изображения в папку нового типа: пользователь видит это до сохранения.
  const kindNotice = kindError ? null : kindChangeNotice(reference, kinds, pinnedShots);
  return (
    <Accordion
      variant="outlined"
      disableGutters
      expanded={expanded}
      onChange={(_event, value) => setExpanded(value)}
      // Свёрнутое содержимое не держим в DOM: скрытые поля и кнопки не попадают в обход и проверки доступности.
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ '&:before': { display: 'none' }, ...(hasErrors ? { borderColor: 'warning.main' } : {}) }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} id={`reference-${reference.key}-summary`} aria-controls={`reference-${reference.key}-details`}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap', minWidth: 0 }}>
          <Typography component="span" fontWeight={600}>
            {reference.name || sourcesTexts.newReference}
          </Typography>
          <Typography component="span" variant="caption" color="text.secondary">
            {sourcesTexts.referenceImages({ kind, count: reference.files.length })}
          </Typography>
          {hasErrors ? (
            <Typography component="span" variant="caption" color="warning.main">
              {sourcesTexts.needsCorrection}
            </Typography>
          ) : null}
          {reference.promptError || reference.files.some((file) => file.promptError) ? (
            <Typography component="span" variant="caption" color="warning.main">
              {sourcesTexts.promptReadFailed}
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
              label={commonTexts.title}
              value={reference.name}
              error={!!nameError}
              helperText={nameError ?? undefined}
              onChange={(e) =>
                onUpdate({ name: e.target.value, id: reference.id && reference.id !== suggestId(reference.name) ? reference.id : suggestId(e.target.value) })
              }
            />
            <TextField
              label={sourcesTexts.referenceId}
              value={reference.id}
              onChange={(e) => onUpdate({ id: e.target.value })}
              error={!!idError}
              helperText={idError ?? sourcesTexts.referenceIdHint}
            />
            <TextField
              select
              label={commonTexts.type}
              value={kinds.some((item) => item.id === reference.kind) ? reference.kind : ''}
              error={!!kindError}
              helperText={kindError ?? undefined}
              onChange={(e) => onUpdate({ kind: e.target.value as ReferenceKind })}
            >
              {kinds.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={sourcesTexts.shortName}
              value={reference.short_name}
              onChange={(e) => onUpdate({ short_name: e.target.value })}
              placeholder={reference.name}
            />
          </Box>
          {kindNotice ? <Alert severity="info">{kindNotice}</Alert> : null}
          <TextField
            label={sourcesTexts.entityDescription}
            fullWidth
            multiline
            minRows={2}
            maxRows={8}
            value={reference.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder={sourcesTexts.entityDescriptionPlaceholder}
            helperText={<LinkedText text={sourcesTexts.entityDescriptionHint} />}
          />
          {removalPending && <Typography role="status">{sourcesTexts.referenceRemovalChecking}</Typography>}
          {removalProblem && <Alert severity="warning">{removalProblem}</Alert>}
          {reference.files.map((file) => (
            <ReferenceFileCard
              key={file.key}
              file={file}
              referenceName={reference.name}
              fileUrl={fileUrl}
              removalPending={removalPending}
              onPreview={() => setPreviewKey(file.key)}
              onUpdate={(patch) => onUpdateFile(file.key, patch)}
              onRemove={() => onRemoveFile(file.key)}
              onRetryPrompt={() => onRetryFilePrompt(file.key)}
            />
          ))}
          {previewIndex >= 0 && (
            // Поздний ответ удаления может изменить набор: новая галерея не наследует индекс прежнего списка.
            <ImageGallery
              key={reference.files.map((file) => file.key).join(':')}
              images={reference.files.map((file) => ({
                imagePath: filePath(file.sourcePath ?? file.existingPath!, !!file.sourcePath),
                label: sourcesTexts.referenceImageAlt({ name: reference.name, view: REFERENCE_VIEW_LABELS[file.view] })
              }))}
              initialIndex={previewIndex}
              kind={sourcesTexts.references}
              onClose={() => setPreviewKey(null)}
            />
          )}
          {filesError ? (
            <Typography variant="body2" color="warning.main">
              {filesError}
            </Typography>
          ) : null}
          <FileDropZone
            label={`${sourcesTexts.pickReferenceImages({ name: reference.name })}. ${sourcesTexts.referenceFilesMessage} ${sourcesTexts.referenceFilesHint}`}
            kind="image"
            multiple
            onFiles={onDropFiles}
            onPick={onAddFiles}
            hint={sourcesTexts.referenceFilesHint}
            message={sourcesTexts.referenceFilesMessage}
          />
          <AiProblemAlert kinds={['image']} />
          <Box>
            <ReferenceImageGenerateButton onClick={onGenerate} />
          </Box>
          <DestructiveButton
            label={sourcesTexts.removeReference({ name: reference.name })}
            description={sourcesTexts.removeReferenceDescription}
            onConfirm={onRemove}
            disabled={removalPending}
            disabledReason={sourcesTexts.referenceRemovalChecking}
            startIcon={<DeleteOutlineIcon />}
            sx={{ alignSelf: 'flex-start' }}
          />
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
