/** Предпочтения видео сохраняются отдельно от возможностей провайдера перед запросом. */

import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useEffect, useState } from 'react';
import { isMediaProvider, MEDIA_PROVIDERS, mediaProviderInfo, mediaProvidersFor, type MediaCapabilities } from '@shared/media-providers';
import { MediaCapabilitiesPanel } from './MediaCapabilitiesPanel';
import { aspectOptions, modelOptions, resolutionOptions } from './generationOptions';
import { Alert, Box, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import type { VideoGenerationSettings as Settings } from '@shared/types';
import { DURATION_RULES, DURATION_RULE_LABELS } from '@shared/types';

const RESOLUTIONS = ['1080p', '720p'];

export function VideoGenerationSettings({
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
  // Выбранный текстовый агент не влияет на провайдера видео: проверка зависит только от явного выбора.
  const canDiscover = providerSelected;
  const capabilitiesReady = canDiscover && capabilities !== null && capabilities.provider === value?.provider;
  const capabilitiesConfirmed = capabilitiesReady && capabilities.available && capabilities.problems.length === 0;
  const models = capabilitiesReady ? capabilities.models : [];
  const availableModels = modelOptions(models, 'video');
  const modelChoices = ['', ...availableModels];
  const defaultModelLabel = mediaProviderInfo(value?.provider, 'video')?.defaultModelLabel ?? 'Автоматически по задаче';
  // Сохранённый ID остаётся видимым, но не становится доступной моделью без подтверждения CLI.
  if (value?.model && !availableModels.includes(value.model)) modelChoices.push(value.model);
  const resolutions = capabilitiesReady ? resolutionOptions(models, value?.model) : RESOLUTIONS;
  const aspects = aspectOptions(models, value?.model);
  const selectedAspect = value?.aspect_ratio ?? (aspects.includes('16:9') ? '16:9' : '');
  // Неполный каталог и недоступный CLI не доказывают несовместимость сохранённых предпочтений.
  const providerError = value !== null && !emptyUnselected && !value.provider.trim();
  const modelError = capabilitiesConfirmed && Boolean(value?.model) && !availableModels.includes(value?.model ?? '');
  const resolutionError =
    value !== null && !emptyUnselected && (!value.resolution.trim() || (capabilitiesConfirmed && !resolutions.includes(value.resolution)));
  const aspectError = value !== null && !emptyUnselected && (!selectedAspect.trim() || (capabilitiesConfirmed && !aspects.includes(selectedAspect)));
  const durationError = value !== null && !emptyUnselected && !DURATION_RULES.includes(value.duration_rule);
  const valid = !value || emptyUnselected || !(providerError || modelError || resolutionError || aspectError || durationError);
  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);
  // Spread сохраняет параметры новых моделей и options при изменении знакомого поля.
  const patch = (next: Partial<Settings>): void => {
    if (value) onChange({ ...value, ...next });
  };

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2">Генерация видео</Typography>
        {!value ? (
          <Alert severity="info">Предпочтения видео не заданы. Добавьте их перед подготовкой видео.</Alert>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary">
              Параметры ниже — предпочтения проекта. Исполнитель подбирает доступную модель под требования запроса.
            </Typography>
            {!providerSelected && value.provider && (
              <Typography variant="caption" color="text.secondary">
                Сохранённый провайдер: {value.provider}. Для запуска выберите его в меню и сохраните настройки.
              </Typography>
            )}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: 1,
                '@container project-settings (min-width: 440px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
                '@container project-settings (min-width: 900px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
                '& > *': { minWidth: 0 }
              }}
            >
              {/* Старое имя провайдера сохраняется в данных; меню подтверждает выбор только явным действием. */}
              <TextField
                select
                id="video-generation-provider"
                label="Провайдер видео"
                error={providerError}
                helperText={
                  emptyUnselected
                    ? 'Провайдер не выбран. Сохранение оставит генерацию отключённой.'
                    : providerError || !providerSelected
                      ? 'Выберите провайдера видео и сохраните настройки.'
                      : undefined
                }
                value={providerSelected ? value.provider : ''}
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                onChange={(event) => {
                  setCapabilities(null);
                  patch({ provider: event.target.value || value.provider, provider_selected: Boolean(event.target.value) });
                }}
                size="small"
              >
                <MenuItem value="">Не выбрано</MenuItem>
                {value.provider && !isMediaProvider(value.provider, 'video') && (
                  <MenuItem value={value.provider}>{value.provider || 'Не задано'} (из файла)</MenuItem>
                )}
                {mediaProvidersFor('video').map((id) => (
                  <MenuItem key={id} value={id}>
                    {MEDIA_PROVIDERS[id].title}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                id="video-generation-model"
                label="Предпочтительная модель видео"
                error={modelError}
                value={value.model ?? ''}
                onChange={(event) => {
                  const model = event.target.value || undefined;
                  // Несохранённый стандарт подставляем только при заявленной поддержке новой модели.
                  const aspect = aspectOptions(models, model).includes('16:9') ? '16:9' : undefined;
                  patch({ model, ...(value.aspect_ratio === undefined ? { aspect_ratio: aspect } : {}) });
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
                    ? `Модель ${value.model} недоступна у провайдера. Выберите доступную или автоматический подбор модели.`
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
              <TextField
                select
                label="Разрешение видео"
                value={value.resolution}
                onChange={(event) => patch({ resolution: event.target.value })}
                size="small"
                error={resolutionError}
                helperText={
                  !value.resolution.trim()
                    ? 'Выберите разрешение видео.'
                    : resolutionError
                      ? `Разрешение ${value.resolution} не поддерживается ${value.model ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`
                      : 'Разрешения выбранной модели; при автоматическом подборе — всех доступных моделей.'
                }
              >
                {!resolutions.includes(value.resolution) && (
                  <MenuItem value={value.resolution} disabled>
                    {value.resolution || 'Не задано'} (недоступно для модели)
                  </MenuItem>
                )}
                {resolutions.map((resolution) => (
                  <MenuItem key={resolution} value={resolution}>
                    {resolution}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                id="video-generation-aspect-ratio"
                label="Пропорции видео"
                error={aspectError}
                value={selectedAspect}
                onChange={(event) => patch({ aspect_ratio: event.target.value })}
                size="small"
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                helperText={
                  !selectedAspect.trim()
                    ? 'Выберите пропорции видео.'
                    : aspectError
                      ? `Пропорции ${selectedAspect} не поддерживаются ${value.model ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`
                      : 'Пропорции выбранной модели; при автоматическом подборе — всех доступных моделей.'
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
                select
                label="Правило длительности"
                error={durationError}
                value={value.duration_rule}
                onChange={(event) => patch({ duration_rule: event.target.value as Settings['duration_rule'] })}
                size="small"
                sx={{ gridColumn: '1 / -1' }}
                helperText={durationError ? 'Выберите известное правило длительности.' : 'Как выбирать длительность запроса относительно окна сцены на шкале'}
              >
                {!DURATION_RULES.includes(value.duration_rule) && (
                  <MenuItem value={value.duration_rule}>{value.duration_rule || 'Не задано'} (из файла)</MenuItem>
                )}
                {DURATION_RULES.map((rule) => (
                  <MenuItem key={rule} value={rule}>
                    {DURATION_RULE_LABELS[rule]}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            {/* Неподтверждённый старый default не должен запускать CLI или проверку входа. */}
            {canDiscover && (
              <MediaCapabilitiesPanel key={`video:${value.provider}`} project={project} kind="video" provider={value.provider} onResult={setCapabilities} />
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
