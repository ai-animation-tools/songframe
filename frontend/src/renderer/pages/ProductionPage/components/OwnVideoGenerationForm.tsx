/**
 * Необязательный раздел окна своего видео «Как сделано видео»: изображения-входы генерации по порядку с ролями и промпт,
 * по которым видео сделано вне приложения (например, на сайте сервиса по одной опоре). Комплект плана сохраняет их как у
 * обычной генерации; пустой раздел ничего не меняет. Раздел свёрнут: видео с телефона он не нужен, а указанное видно
 * заметным статусом в заголовке. Файлы выбираются диалогом или перетаскиванием; формат и роли окончательно проверяет Go,
 * здесь — только причина недоступности загрузки, которую окно показывает у своей кнопки (onChange).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { componentsTexts } from '@shared/texts/components';
import { productionTexts } from '@shared/texts/production';
import type { OwnVideoGeneration, OwnVideoInputRole } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { FileDropZone } from '../../../components/FileDropZone';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { IMAGE_FILTER } from '../../../file-filters';
import {
  generationOf,
  generationProblem,
  moveInput,
  OWN_VIDEO_INPUT_LIMIT,
  roleProblem,
  withDefaultRoles,
  type OwnVideoDraftInput
} from '../ownVideoGeneration';

const texts = productionTexts.ownVideo.generation;
const ROLES: OwnVideoInputRole[] = ['first', 'middle', 'last'];

/** Имя файла без папок: так файл виден в проводнике. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export function OwnVideoGenerationForm({
  busy,
  busyReason,
  onChange
}: {
  busy: boolean;
  busyReason: string;
  /** Сведения для Go и причина, почему загрузить их пока нельзя (null — можно). */
  onChange(generation: OwnVideoGeneration, problem: string | null): void;
}): ReactElement {
  const [inputs, setInputs] = useState<OwnVideoDraftInput[]>([]);
  const [prompt, setPrompt] = useState('');
  const [gallery, setGallery] = useState<number | null>(null);
  // Счётчик id строк: один файл может стоять в списке дважды (первым и последним кадром).
  const nextId = useRef(0);
  const problem = generationProblem(inputs);
  const generation = generationOf(inputs, prompt);
  const generationKey = JSON.stringify(generation);
  useEffect(() => {
    onChange(generation, problem);
    // Сообщаем только смену содержимого, а не каждый новый объект обработчика.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationKey, problem]);

  const full = inputs.length >= OWN_VIDEO_INPUT_LIMIT;
  const add = (files: string[]): void => {
    if (!files.length) return;
    setInputs((current) =>
      withDefaultRoles([...current, ...files.map((file) => ({ id: `input-${nextId.current++}`, file, role: 'middle' as const, chosen: false }))])
    );
  };
  const pick = async (): Promise<void> => {
    add(await window.api.dialog.pickFiles({ title: texts.add, filters: IMAGE_FILTER, multiple: true }));
  };
  const filled = inputs.length > 0 || prompt.trim() !== '';
  const images = inputs.map((input, index) => ({ imagePath: input.file, label: texts.input({ index: index + 1 }) }));

  return (
    <Accordion variant="outlined" disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="subtitle2">{texts.heading}</Typography>
          {/* Указанное — заметный статус, видимый и в свёрнутом разделе. */}
          {filled ? (
            <Chip size="small" color="success" label={texts.filled({ inputs: inputs.length, prompt: prompt.trim() !== '' })} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {texts.optional}
            </Typography>
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            {texts.intro}
          </Typography>
          {inputs.length ? (
            <Stack spacing={1} role="list" aria-label={texts.inputs}>
              {inputs.map((input, index) => {
                const name = fileName(input.file);
                const label = texts.input({ index: index + 1 });
                const error = roleProblem(input.role, index, inputs.length);
                return (
                  <Box key={input.id} role="listitem" aria-label={`${label}: ${name}`} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                    <Box sx={{ width: 96, flexShrink: 0 }}>
                      <ImageThumbnail path={input.file} label={label} title={input.file} fit="cover" onOpen={() => setGallery(index)} />
                    </Box>
                    <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" noWrap title={input.file}>
                        {`${label} · ${name}`}
                      </Typography>
                      <TextField
                        select
                        size="small"
                        label={texts.role}
                        value={input.role}
                        disabled={busy}
                        error={!!error}
                        helperText={error}
                        onChange={(event) => {
                          const role = event.target.value as OwnVideoInputRole;
                          setInputs((current) => current.map((item) => (item.id === input.id ? { ...item, role, chosen: true } : item)));
                        }}
                        sx={{ maxWidth: 240 }}
                      >
                        {ROLES.map((role) => (
                          <MenuItem key={role} value={role}>
                            {texts.roles[role]}
                          </MenuItem>
                        ))}
                      </TextField>
                    </Stack>
                    <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                      <ActionIconButton
                        size="small"
                        aria-label={texts.moveUp({ name: label })}
                        disabled={busy || index === 0}
                        disabledReason={busy ? busyReason : texts.alreadyFirst}
                        onClick={() => setInputs((current) => moveInput(current, index, -1))}
                      >
                        <ArrowUpwardIcon fontSize="small" />
                      </ActionIconButton>
                      <ActionIconButton
                        size="small"
                        aria-label={texts.moveDown({ name: label })}
                        disabled={busy || index === inputs.length - 1}
                        disabledReason={busy ? busyReason : texts.alreadyLast}
                        onClick={() => setInputs((current) => moveInput(current, index, 1))}
                      >
                        <ArrowDownwardIcon fontSize="small" />
                      </ActionIconButton>
                      <ActionIconButton
                        size="small"
                        aria-label={texts.remove({ name: label })}
                        disabled={busy}
                        disabledReason={busyReason}
                        onClick={() => setInputs((current) => withDefaultRoles(current.filter((item) => item.id !== input.id)))}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </ActionIconButton>
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          ) : null}
          {inputs.length ? (
            <Stack direction="row">
              <ActionButton
                variant="outlined"
                startIcon={<AddPhotoAlternateOutlinedIcon />}
                title={texts.addHint}
                disabled={busy || full}
                disabledReason={busy ? busyReason : texts.limit({ limit: OWN_VIDEO_INPUT_LIMIT })}
                onClick={() => void pick()}
              >
                {texts.add}
              </ActionButton>
            </Stack>
          ) : (
            // Пустой список — зона выбора и перетаскивания, как у видео формы выше.
            // Доступное имя повторяет видимый текст зоны вместе с подсказкой, как у зоны видео.
            <FileDropZone
              label={`${texts.zone} ${componentsTexts.fileDrop.image.pickMultiple} ${componentsTexts.fileDrop.image.formats}`}
              kind="image"
              multiple
              message={texts.zone}
              onFiles={add}
              onPick={busy ? undefined : pick}
            />
          )}
          <TextField
            label={texts.prompt}
            multiline
            fullWidth
            minRows={3}
            maxRows={10}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            helperText={texts.promptHint}
          />
        </Stack>
      </AccordionDetails>
      {gallery !== null && images.length ? (
        <ImageGallery kind={productionTexts.packageKeyframes.galleryKind} images={images} initialIndex={gallery} onClose={() => setGallery(null)} />
      ) : null}
    </Accordion>
  );
}
