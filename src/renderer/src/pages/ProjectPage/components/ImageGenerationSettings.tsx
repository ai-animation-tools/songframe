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
  const defaultModelLabel = info?.defaultModelLabel ?? 'Автоматически по задаче';
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
        <Typography variant="subtitle2">Генерация изображений</Typography>
        {!value ? (
          <Alert severity="info">Исполнитель изображений не задан. Добавьте его перед подготовкой опорных кадров.</Alert>
        ) : (
          <>
            {!providerSelected && value.provider && (
              <Typography variant="caption" color="text.secondary">
                Сохранённый провайдер: {savedTitle}. Для запуска выберите его в меню и сохраните настройки.
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
                label="Провайдер изображений"
                error={providerError}
                helperText={
                  emptyUnselected
                    ? 'Провайдер не выбран. Сохранение оставит генерацию отключённой.'
                    : providerError || !providerSelected
                      ? 'Выберите провайдера изображений и сохраните настройки.'
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
                <MenuItem value="">Не выбрано</MenuItem>
                {value.provider && !isMediaProvider(value.provider, 'image') && (
                  <MenuItem value={value.provider}>{value.provider || 'Не задано'} (из файла)</MenuItem>
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
                  label={executor && info ? `Модель агента ${info.title} для изображений` : 'Предпочтительная модель изображений'}
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
                      renderValue: () => (value.model ? `${value.model}${availableModels.includes(value.model) ? '' : ' (недоступна)'}` : defaultModelLabel)
                    }
                  }}
                  helperText={
                    modelError
                      ? executor
                        ? `Модель ${value.model} недоступна у провайдера. Выберите доступную модель или пункт «${defaultModelLabel}».`
                        : `Модель ${value.model} недоступна у провайдера. Выберите доступную или автоматический подбор модели.`
                      : executor && info
                        ? `По умолчанию используется модель из настроек ${info.title}. Здесь выбирается модель агента, который готовит изображение, а не модель самого генератора изображений.`
                        : 'Автоматически — подбор по требованиям задачи. Выбранная модель — предпочтение; несовместимая будет заменена с объяснением при согласовании.'
                  }
                >
                  {modelChoices.map((id) => (
                    <MenuItem key={id} value={id} disabled={Boolean(id) && !availableModels.includes(id)}>
                      <Box>
                        <Typography variant="body2">{id ? `${id}${availableModels.includes(id) ? '' : ' (недоступна)'}` : defaultModelLabel}</Typography>
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
                        label="Разрешение изображений"
                        error={resolutionError}
                        helperText={
                          !selectedResolution.trim()
                            ? 'Выберите разрешение изображений.'
                            : resolutionError
                              ? `Разрешение ${selectedResolution} не поддерживается ${value.model ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`
                              : 'Разрешения выбранной модели; при автоматическом подборе — всех доступных моделей. Можно ввести вручную.'
                        }
                      />
                    )}
                  />
                  <TextField
                    select
                    id="image-generation-aspect-ratio"
                    label="Пропорции изображений"
                    error={aspectError}
                    value={selectedAspect}
                    onChange={(event) => patch({ aspect_ratio: event.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                    helperText={
                      aspectError && !selectedAspect.trim()
                        ? 'Выберите пропорции изображений.'
                        : aspectError
                          ? `Пропорции ${selectedAspect} не поддерживаются ${value.model ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`
                          : 'Пропорции выбранной модели: от широких к вертикальным, auto в конце. При автоматическом подборе — варианты всех моделей.'
                    }
                  >
                    <MenuItem value="" disabled>
                      Выберите пропорции
                    </MenuItem>
                    {selectedAspect && !aspects.includes(selectedAspect) && (
                      <MenuItem value={selectedAspect} disabled>
                        {selectedAspect} (недоступны для модели)
                      </MenuItem>
                    )}
                    {aspects.map((aspect) => (
                      <MenuItem key={aspect} value={aspect}>
                        {aspect}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label="Количество изображений"
                    type="number"
                    value={Number.isFinite(selectedOutputs) ? selectedOutputs : ''}
                    onChange={(event) => patch({ outputs: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
                    error={outputsError}
                    size="small"
                    inputProps={{ min: 1, step: 1 }}
                    helperText={
                      outputsError
                        ? 'Введите целое количество изображений от 1.'
                        : 'Число вариантов одной опоры в запросе, а не число кадров. Больше вариантов может увеличить стоимость.'
                    }
                  />
                </>
              )}
            </Box>
            {!providerSelected ? null : !requestParameters && info ? (
              <Typography variant="caption" color="text.secondary">
                {`Генерацию выполняет ${info.title} встроенным инструментом изображений. Доступные размеры и форматы определяет исполнитель при подготовке запроса. Сейчас создаётся один вариант для каждой опоры. Параметры запроса — количество вариантов, разрешение и пропорции — к этому исполнителю не применяются.`}
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Параметры сохраняются как предпочтения. Исполнитель подбирает доступную модель под требования запроса.
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
            Добавить
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
