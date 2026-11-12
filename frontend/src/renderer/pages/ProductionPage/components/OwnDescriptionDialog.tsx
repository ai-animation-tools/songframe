/**
 * Своё описание плана без агента: текст, длительность запроса и план опор. «Сохранить и принять» отдаёт текст Go: он проверяет его
 * правилами ответа агента, записывает в попытку, а интерфейс сразу принимает (D-045). Черновик закрывается только кнопкой отмены.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Autocomplete, Box, Chip, IconButton, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { productionTexts } from '@shared/texts/production';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { LinkedText } from '../../../components/LinkedText';
import { joinPath } from '../../../format';
import { addFrame, draftProblem, frameId, frameRole, type OwnDescriptionDraft } from '../ownDescription';

const texts = productionTexts.ownDescriptionDialog;

export function OwnDescriptionDialog({
  project,
  shot,
  windowSeconds,
  initial,
  limit,
  manual,
  busy,
  error,
  onClose,
  onSave
}: {
  project: string;
  shot: string;
  /** Окно плана, секунды: подсказка к длительности запроса. */
  windowSeconds: number;
  initial: OwnDescriptionDraft;
  /** Предел числа опор провайдера видео. */
  limit: number;
  /** Речевой план ручной генерации: ровно одна опора, добавлять нельзя. */
  manual: boolean;
  busy: boolean;
  /** Отказ Go последней попытки сохранения: окно остаётся открытым для исправления. */
  error: string | null;
  onClose(): void;
  onSave(draft: OwnDescriptionDraft): void;
}): ReactElement {
  const [draft, setDraft] = useState(initial);
  const [images, setImages] = useState<string[]>([]);
  const [gallery, setGallery] = useState<{ paths: string[]; index: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Список референсов — удобство выбора; без него поле принимает уже указанные пути, а проверку выполнит Go.
    window.api.productionWorkflow
      .referenceImages(project, shot)
      .then((paths) => !cancelled && setImages(paths))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project, shot]);
  const problem = draftProblem(draft, manual ? 1 : limit);
  const setFrame = (index: number, patch: Partial<OwnDescriptionDraft['frames'][number]>): void =>
    setDraft({ ...draft, frames: draft.frames.map((frame, at) => (at === index ? { ...frame, ...patch } : frame)) });
  const count = draft.frames.length;
  return (
    <ConfirmationDialog
      open
      maxWidth="md"
      explicitCancelOnly
      title={texts.title({ shot })}
      contentLabel={texts.title({ shot })}
      confirmLabel={texts.save}
      confirmIcon={<CheckIcon />}
      confirmDisabled={busy || !!problem}
      confirmDisabledReason={busy ? productionTexts.productionWorkflowPanel.loadingReason : problem}
      cancelDisabled={busy}
      onClose={onClose}
      onConfirm={() => onSave(draft)}
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {texts.saveHint}
        </Typography>
        {error ? (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        ) : null}
        <TextField
          label={texts.description}
          multiline
          minRows={4}
          maxRows={14}
          autoFocus
          helperText={texts.descriptionHint}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
        <TextField
          label={texts.requestSeconds}
          type="number"
          sx={{ maxWidth: 260 }}
          slotProps={{ htmlInput: { min: 1, step: 1 } }}
          helperText={texts.requestSecondsHint({ window: windowSeconds.toFixed(2).replace('.', ',') })}
          value={draft.requestSeconds}
          onChange={(event) => setDraft({ ...draft, requestSeconds: event.target.value })}
        />
        <Box>
          <Typography variant="subtitle2">{texts.frames}</Typography>
          <Typography variant="body2" color="text.secondary">
            {manual ? texts.manualSingle : `${texts.framesHint}. ${texts.limit({ limit })}.`}
          </Typography>
        </Box>
        {draft.frames.map((frame, index) => {
          const id = frameId(index);
          const role = frameRole(index, count);
          return (
            <Paper key={index} variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="subtitle2" sx={{ flex: 1 }}>
                    {texts.frameTitle({ id, role })}
                  </Typography>
                  {role === 'middle' ? (
                    <TextField
                      size="small"
                      type="number"
                      label={texts.time}
                      sx={{ width: 120 }}
                      slotProps={{ htmlInput: { min: 0, step: 0.1 } }}
                      value={frame.time}
                      onChange={(event) => setFrame(index, { time: event.target.value })}
                    />
                  ) : (
                    <Chip size="small" label={`${role === 'first' ? 0 : draft.requestSeconds || '—'} с`} />
                  )}
                  {count > 1 ? (
                    <Tooltip title={texts.removeFrame({ id })}>
                      <span>
                        <IconButton
                          size="small"
                          aria-label={texts.removeFrame({ id })}
                          disabled={busy}
                          onClick={() => setDraft({ ...draft, frames: draft.frames.filter((_, at) => at !== index) })}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  ) : null}
                </Stack>
                <TextField
                  label={texts.prompt}
                  helperText={texts.promptHint}
                  multiline
                  minRows={2}
                  maxRows={8}
                  value={frame.prompt}
                  onChange={(event) => setFrame(index, { prompt: event.target.value })}
                />
                <Autocomplete
                  multiple
                  size="small"
                  options={images}
                  value={frame.referencePaths}
                  onChange={(_, value) => setFrame(index, { referencePaths: value })}
                  renderInput={(params) => <TextField {...params} label={texts.references} />}
                />
                {frame.referencePaths.length ? (
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    {frame.referencePaths.map((path, at) => (
                      <Box key={path} sx={{ width: 120 }}>
                        <ImageThumbnail
                          path={joinPath(project, path)}
                          label={path.split('/').at(-1) ?? path}
                          title={path}
                          onOpen={() => setGallery({ paths: frame.referencePaths, index: at })}
                        />
                      </Box>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            </Paper>
          );
        })}
        {!manual ? (
          <ActionButton
            size="small"
            startIcon={<AddIcon />}
            sx={{ alignSelf: 'flex-start' }}
            disabled={busy || count >= limit}
            disabledReason={busy ? productionTexts.productionWorkflowPanel.loadingReason : texts.limit({ limit })}
            onClick={() => setDraft(addFrame(draft))}
          >
            {texts.addFrame}
          </ActionButton>
        ) : null}
      </Stack>
      {gallery ? (
        <ImageGallery
          kind={texts.references}
          images={gallery.paths.map((path) => ({ imagePath: joinPath(project, path), label: path }))}
          initialIndex={gallery.index}
          onClose={() => setGallery(null)}
        />
      ) : null}
    </ConfirmationDialog>
  );
}
