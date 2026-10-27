/** Выбор исполнителя изображений не меняет отдельные настройки текстового агента. */

import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useEffect, useState } from 'react';
import type { MediaCapabilities } from '@shared/media-providers';
import { MediaCapabilitiesPanel } from './MediaCapabilitiesPanel';
import { Alert, Autocomplete, Box, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { DEFAULT_KLING_IMAGE_GENERATION, type ImageGenerationSettings as Settings } from '@shared/types';
import { aspectOptions, modelOptions, resolutionOptions } from './generationOptions';
import { useApp } from '../../../state';

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
  const { agentProvider } = useApp();
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const providerSelected = value?.provider_selected === true;
  // Пустой неподтверждённый черновик сохраняется как null в ProjectSettingsCard и не блокирует обычное сохранение.
  const emptyUnselected = value !== null && !providerSelected && !value.provider.trim();
  // Даже сохранённый Codex не разрешает запуск CLI при другом глобальном агенте.
  const canDiscover = Boolean(agentProvider) && providerSelected && (value?.provider !== 'codex' || agentProvider === 'codex');
  const capabilitiesReady = canDiscover && capabilities !== null && capabilities.provider === value?.provider;
  const capabilitiesConfirmed = capabilitiesReady && capabilities.available && capabilities.problems.length === 0;
  const models = capabilitiesReady ? capabilities.models : [];
  // Codex возвращает собственный порядок каталога агента; рейтинг моделей Kling к нему не относится.
  const availableModels = value?.provider === 'codex' ? [...new Set(models.map((model) => model.id))] : modelOptions(models, 'image');
  const modelChoices = ['', ...availableModels];
  const defaultModelLabel = value?.provider === 'codex' ? 'Как указано в Codex CLI' : 'Автоматически по задаче';
  const resolutions = resolutionOptions(models, value?.model);
  const selectedResolution = value?.resolution ?? DEFAULT_KLING_IMAGE_GENERATION.resolution ?? '2k';
  const aspects = aspectOptions(models, value?.model);
  const defaultAspect = DEFAULT_KLING_IMAGE_GENERATION.aspect_ratio ?? '16:9';
  const selectedAspect = value?.aspect_ratio ?? (aspects.includes(defaultAspect) ? defaultAspect : '');
  const selectedOutputs = value?.outputs ?? DEFAULT_KLING_IMAGE_GENERATION.outputs ?? 1;
  const needsProviderParameters = Boolean(value) && !emptyUnselected && value?.provider !== 'codex';
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
    <Paper component="section" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2">Генерация изображений</Typography>
        {!value ? (
          <Alert severity="info">Исполнитель изображений не задан. Добавьте его перед подготовкой опорных кадров.</Alert>
        ) : (
          <>
            {!providerSelected && value.provider && (
              <Typography variant="caption" color="text.secondary">
                Сохранённый провайдер: {value.provider}. Для запуска выберите его в меню и сохраните настройки.
              </Typography>
            )}
            {agentProvider !== 'codex' && (
              <Typography variant="caption" color="text.secondary">
                Для изображений Codex сначала выберите агента Codex в настройках приложения.
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
                  if (provider === 'codex' && agentProvider !== 'codex') return;
                  // Только обработчик выбора подтверждает провайдера; параметры и расширения прежнего исполнителя сохраняются.
                  patch({
                    provider: provider || value.provider,
                    provider_selected: Boolean(provider),
                    ...(provider === 'kling'
                      ? {
                          resolution: value.resolution ?? DEFAULT_KLING_IMAGE_GENERATION.resolution,
                          aspect_ratio: value.aspect_ratio ?? DEFAULT_KLING_IMAGE_GENERATION.aspect_ratio,
                          outputs: value.outputs ?? DEFAULT_KLING_IMAGE_GENERATION.outputs
                        }
                      : {})
                  });
                }}
                size="small"
              >
                <MenuItem value="">Не выбрано</MenuItem>
                {value.provider && !['codex', 'kling'].includes(value.provider) && (
                  <MenuItem value={value.provider}>{value.provider || 'Не задано'} (из файла)</MenuItem>
                )}
                <MenuItem value="codex" disabled={agentProvider !== 'codex'}>
                  Codex
                </MenuItem>
                <MenuItem value="kling">Kling</MenuItem>
              </TextField>
              <TextField
                select
                id="image-generation-model"
                label={value.provider === 'codex' ? 'Модель агента Codex для изображений' : 'Предпочтительная модель изображений'}
                error={modelError}
                value={value.model ?? ''}
                onChange={(event) => {
                  const model = event.target.value || undefined;
                  // Несохранённый стандарт подставляем только при заявленной поддержке новой модели.
                  const aspect = aspectOptions(models, model).includes(defaultAspect) ? defaultAspect : undefined;
                  patch({ model, ...(value.provider !== 'codex' && value.aspect_ratio === undefined ? { aspect_ratio: aspect } : {}) });
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
                    ? value.provider === 'codex'
                      ? `Модель ${value.model} недоступна у провайдера. Выберите доступную модель или пункт «Как указано в Codex CLI».`
                      : `Модель ${value.model} недоступна у провайдера. Выберите доступную или автоматический подбор модели.`
                    : value.provider === 'codex'
                      ? 'По умолчанию используется модель из настроек Codex CLI. Здесь выбирается модель агента, который готовит изображение, а не модель самого генератора изображений.'
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
              {value.provider !== 'codex' && (
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
            {value.provider === 'codex' ? (
              <Typography variant="caption" color="text.secondary">
                Генерацию выполняет Codex встроенным инструментом изображений. Доступные размеры и форматы определяет исполнитель при подготовке запроса. Сейчас
                создаётся один вариант для каждой опоры. Количество вариантов, разрешение и пропорции из параметров Kling к этому исполнителю не применяются.
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Параметры сохраняются как предпочтения. Исполнитель подбирает доступную модель под требования запроса.
              </Typography>
            )}
            {value.provider === 'codex' && (
              <Alert severity="info">
                В наших проверках горизонтальные изображения получались размером 1672×941, в том числе при запросе 4K. Точный размер через промпт не
                гарантируется.
              </Alert>
            )}
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
