import { projectTexts } from '@shared/texts/project';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
/** Выбор исполнителя изображений не меняет отдельные настройки текстового агента. */

import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useEffect, useState } from 'react';
import { isMediaProvider, MEDIA_PROVIDERS, mediaProviderInfo, mediaProvidersFor, type MediaCapabilities } from '@shared/media-providers';
import { MediaCapabilitiesPanel } from './MediaCapabilitiesPanel';
import { switchGenerationProvider } from '@shared/generation-settings';
import { ANCHORS } from '../../../components/linkTargets';
import { Alert, Autocomplete, Box, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import type { ImageGenerationSettings as Settings } from '@shared/types';
import { aspectOptions, modelOptions, resolutionOptions } from './generationOptions';

export function ImageGenerationSettings({
  project,
  value,
  onChange,
  onAdd,
  onValidityChange
}: {
  project: string;
  value: Settings | null;
  onChange: (value: Settings) => void;
  onAdd: () => void;
  onValidityChange?: (valid: boolean) => void;
}): ReactElement {
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const providerSelected = value?.provider_selected === true;
  // Пустой неподтверждённый черновик сохраняется как null в ProjectSettingsCard и не блокирует обычное сохранение.
  const emptyUnselected = value !== null && !providerSelected && !value.provider.trim();
  // Сведения о провайдере берутся из реестра и только для явно выбранного провайдера: «Не выбрано» не показывает чужих полей.
  // Неизвестное имя из файла ведёт себя как провайдер с параметрами запроса.
  const info = providerSelected ? mediaProviderInfo(value?.provider, 'image') : null;
  const savedTitle = mediaProviderInfo(value?.provider, 'image')?.title ?? value?.provider;
  const executor = info?.executor ?? null;
  const requestParameters = info?.requestParameters ?? true;
  // Выбранный текстовый агент не влияет на провайдера изображений: проверка зависит только от явного выбора.
  const canDiscover = providerSelected;
  const capabilitiesReady = canDiscover && capabilities !== null && capabilities.provider === value?.provider;
  const capabilitiesConfirmed = capabilitiesReady && capabilities.available && capabilities.problems.length === 0;
  const models = capabilitiesReady ? capabilities.models : [];
  // Агент-исполнитель возвращает собственный порядок каталога; рейтинг моделей прямых провайдеров к нему не относится.
  const availableModels = executor ? [...new Set(models.map((model) => model.id))] : modelOptions(models, 'image', value?.provider);
  const modelChoices = ['', ...availableModels];
  const defaultModelLabel = info?.defaultModelLabel ?? projectTexts.generation.automaticModel;
  const resolutions = resolutionOptions(models, value?.model);
  // Значения по умолчанию задаёт провайдер в реестре.
  const defaults = info?.defaults.image ?? {};
  const selectedResolution = value?.resolution ?? defaults.resolution ?? '';
  const aspects = aspectOptions(models, value?.model);
  const defaultAspect = defaults.aspect_ratio ?? '';
  const selectedAspect = value?.aspect_ratio ?? (aspects.includes(defaultAspect) ? defaultAspect : '');
  const selectedOutputs = value?.outputs ?? defaults.outputs ?? 1;
  // Без выбранного провайдера поля параметров скрыты: скрытое поле не может блокировать сохранение.
  const needsProviderParameters = providerSelected && requestParameters;
  // Неполный каталог и скрытые поля другого исполнителя не блокируют сохранение проекта.
  const providerError = value !== null && !emptyUnselected && !value.provider.trim();
  const modelError = capabilitiesConfirmed && Boolean(value?.model) && !availableModels.includes(value?.model ?? '');
  const resolutionError = needsProviderParameters && (!selectedResolution.trim() || (capabilitiesConfirmed && !resolutions.includes(selectedResolution)));
  const aspectError =
    needsProviderParameters &&
    ((value?.aspect_ratio !== undefined && !value.aspect_ratio.trim()) || (capabilitiesConfirmed && (!selectedAspect || !aspects.includes(selectedAspect))));
  const outputsError = needsProviderParameters && (!Number.isInteger(selectedOutputs) || selectedOutputs < 1);
  const valid = !value || emptyUnselected || !(providerError || modelError || resolutionError || aspectError || outputsError);
  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);
  // Сохранённый ID остаётся видимым, но не становится доступной моделью без подтверждения CLI.
  if (value?.model && !availableModels.includes(value.model)) modelChoices.push(value.model);
  // Неизвестные параметры и настройки другого провайдера переживают переключение исполнителя.
  const patch = (next: Partial<Settings>): void => {
    if (value) onChange({ ...value, ...next });
  };

  return (
    <Paper component="section" variant="outlined" data-anchor={ANCHORS.projectImageGeneration} sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2">{navigationTexts.blocks.projectImageGeneration}</Typography>
        {!value ? (
          <Alert severity="info">{projectTexts.generation.imageMissing}</Alert>
        ) : (
          <>
            {!providerSelected && value.provider && (
              <Typography variant="caption" color="text.secondary">
                {projectTexts.generation.savedProvider({ provider: savedTitle ?? '' })}
              </Typography>
            )}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: 1,
                '@container project-settings (min-width: 440px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
                '& > *': { minWidth: 0 }
              }}
            >
              {/* Старое имя провайдера сохраняется в данных; меню подтверждает выбор только явным действием. */}
              <TextField
                select
                id="image-generation-provider"
                label={projectTexts.generation.imageProvider}
                error={providerError}
                helperText={
                  emptyUnselected
                    ? projectTexts.generation.providerUnselected
                    : providerError || !providerSelected
                      ? projectTexts.generation.chooseImageProvider
                      : undefined
                }
                value={providerSelected ? value.provider : ''}
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                onChange={(event) => {
                  setCapabilities(null);
                  const provider = event.target.value;
                  const selected = mediaProviderInfo(provider, 'image');
                  // «Не выбрано» только снимает подтверждение: сохранённые значения остаются до явного выбора.
                  if (!provider) return patch({ provider_selected: false });
                  // Подтверждение того же провайдера сохраняет его значения и дополняет недостающие значениями по умолчанию из реестра.
                  if (provider === value.provider) {
                    const defaults: Record<string, unknown> = selected?.requestParameters ? { ...selected.defaults.image } : {};
                    const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => value[key] === undefined));
                    return patch({ ...missing, provider_selected: true });
                  }
                  // Другой провайдер: всё, что от него зависит, заменяется значениями нового; поля проекта сохраняются.
                  onChange(switchGenerationProvider('image', value, provider));
                }}
                size="small"
              >
                <MenuItem value="">{commonTexts.notSelected}</MenuItem>
                {value.provider && !isMediaProvider(value.provider, 'image') && (
                  <MenuItem value={value.provider}>{projectTexts.generation.fromFile(value.provider || commonTexts.notSpecified)}</MenuItem>
                )}
                {mediaProvidersFor('image').map((id) => (
                  <MenuItem key={id} value={id}>
                    {MEDIA_PROVIDERS[id].title}
                  </MenuItem>
                ))}
              </TextField>
              {providerSelected && (
                <TextField
                  select
                  id="image-generation-model"
                  label={executor && info ? projectTexts.generation.agentImageModel({ provider: info.title }) : projectTexts.generation.preferredImageModel}
                  error={modelError}
                  value={value.model ?? ''}
                  onChange={(event) => {
                    const model = event.target.value || undefined;
                    // Несохранённый стандарт подставляем только при заявленной поддержке новой модели.
                    const aspect = aspectOptions(models, model).includes(defaultAspect) ? defaultAspect : undefined;
                    patch({ model, ...(requestParameters && value.aspect_ratio === undefined ? { aspect_ratio: aspect } : {}) });
                  }}
                  size="small"
                  slotProps={{
                    inputLabel: { shrink: true },
                    select: {
                      displayEmpty: true,
                      // Закрытое поле остаётся однострочным, команды видны только в меню.
                      renderValue: () =>
                        value.model
                          ? projectTexts.generation.modelChoice({ model: value.model, available: availableModels.includes(value.model) })
                          : defaultModelLabel
                    }
                  }}
                  helperText={
                    modelError
                      ? executor
                        ? projectTexts.generation.agentModelUnavailable({ model: value.model, defaultModelLabel })
                        : projectTexts.generation.modelUnavailable({ model: value.model })
                      : executor && info
                        ? projectTexts.generation.agentModelHelp({ provider: info.title })
                        : projectTexts.generation.modelHelp
                  }
                >
                  {modelChoices.map((id) => (
                    <MenuItem key={id} value={id} disabled={Boolean(id) && !availableModels.includes(id)}>
                      <Box>
                        <Typography variant="body2">
                          {id ? projectTexts.generation.modelChoice({ model: id, available: availableModels.includes(id) }) : defaultModelLabel}
                        </Typography>
                        {availableModels.includes(id) && (
                          <Typography variant="caption" color="text.secondary">
                            {Array.from(new Set(models.filter((model) => model.id === id).map((model) => model.command))).join(', ')}
                          </Typography>
                        )}
                      </Box>
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {providerSelected && requestParameters && (
                <>
                  <Autocomplete
                    freeSolo
                    forcePopupIcon
                    options={resolutions}
                    value={selectedResolution}
                    onChange={(_event, resolution) => patch({ resolution: resolution || undefined })}
                    onInputChange={(_event, resolution, reason) => {
                      if (reason === 'input') patch({ resolution: resolution || undefined });
                    }}
                    size="small"
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label={projectTexts.generation.imageResolution}
                        error={resolutionError}
                        helperText={
                          !selectedResolution.trim()
                            ? projectTexts.generation.chooseImageResolution
                            : resolutionError
                              ? projectTexts.generation.resolutionUnsupported({ resolution: selectedResolution, preferredModel: Boolean(value.model) })
                              : projectTexts.generation.imageResolutionHelp
                        }
                      />
                    )}
                  />
                  <TextField
                    select
                    id="image-generation-aspect-ratio"
                    label={projectTexts.generation.imageAspect}
                    error={aspectError}
                    value={selectedAspect}
                    onChange={(event) => patch({ aspect_ratio: event.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                    helperText={
                      aspectError && !selectedAspect.trim()
                        ? projectTexts.generation.chooseImageAspect
                        : aspectError
                          ? projectTexts.generation.aspectUnsupported({ aspect: selectedAspect, preferredModel: Boolean(value.model) })
                          : projectTexts.generation.imageAspectHelp
                    }
                  >
                    <MenuItem value="" disabled>
                      {projectTexts.generation.chooseAspect}
                    </MenuItem>
                    {selectedAspect && !aspects.includes(selectedAspect) && (
                      <MenuItem value={selectedAspect} disabled>
                        {projectTexts.generation.aspectUnavailable(selectedAspect)}
                      </MenuItem>
                    )}
                    {aspects.map((aspect) => (
                      <MenuItem key={aspect} value={aspect}>
                        {aspect}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label={projectTexts.generation.imageCount}
                    type="number"
                    value={Number.isFinite(selectedOutputs) ? selectedOutputs : ''}
                    onChange={(event) => patch({ outputs: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
                    error={outputsError}
                    size="small"
                    inputProps={{ min: 1, step: 1 }}
                    helperText={outputsError ? projectTexts.generation.imageCountInvalid : projectTexts.generation.imageCountHelp}
                  />
                </>
              )}
            </Box>
            {!providerSelected ? null : !requestParameters && info ? (
              <Typography variant="caption" color="text.secondary">
                {projectTexts.generation.agentExecution({ provider: info.title })}
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                {projectTexts.generation.imagePreferences}
              </Typography>
            )}
            {/* Наблюдение конкретного провайдера хранится в реестре и показывается только при его выборе. */}
            {info?.settingsNotes.image && <Alert severity="info">{info.settingsNotes.image}</Alert>}
            {/* Неподтверждённый старый default не должен запускать CLI или проверку входа. */}
            {canDiscover && (
              <MediaCapabilitiesPanel key={`image:${value.provider}`} project={project} kind="image" provider={value.provider} onResult={setCapabilities} />
            )}
          </>
        )}
        {!value && (
          <Button size="small" variant="outlined" color="success" startIcon={<AddIcon />} onClick={onAdd} sx={{ alignSelf: 'start' }}>
            {commonTexts.add}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
