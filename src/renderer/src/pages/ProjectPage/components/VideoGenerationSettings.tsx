import { projectTexts } from '@shared/texts/project';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
/** Предпочтения видео сохраняются отдельно от возможностей провайдера перед запросом. */

import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useEffect, useState } from 'react';
import { isMediaProvider, MEDIA_PROVIDERS, mediaProviderInfo, mediaProvidersFor, type MediaCapabilities } from '@shared/media-providers';
import { MediaCapabilitiesPanel } from './MediaCapabilitiesPanel';
import { ANCHORS } from '../../../components/linkTargets';
import { switchGenerationProvider } from '@shared/generation-settings';
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
  const availableModels = modelOptions(models, 'video', value?.provider);
  const modelChoices = ['', ...availableModels];
  const defaultModelLabel =
    (providerSelected ? mediaProviderInfo(value?.provider, 'video')?.defaultModelLabel : null) ?? projectTexts.generation.automaticModel;
  const savedTitle = mediaProviderInfo(value?.provider, 'video')?.title ?? value?.provider;
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
    <Paper component="section" variant="outlined" data-anchor={ANCHORS.projectVideoGeneration} sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2">{navigationTexts.blocks.projectVideoGeneration}</Typography>
        {!value ? (
          <Alert severity="info">{projectTexts.generation.videoMissing}</Alert>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary">
              {projectTexts.generation.videoPreferences}
            </Typography>
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
                '@container project-settings (min-width: 900px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' },
                '& > *': { minWidth: 0 }
              }}
            >
              {/* Старое имя провайдера сохраняется в данных; меню подтверждает выбор только явным действием. */}
              <TextField
                select
                id="video-generation-provider"
                label={projectTexts.generation.videoProvider}
                error={providerError}
                helperText={
                  emptyUnselected
                    ? projectTexts.generation.providerUnselected
                    : providerError || !providerSelected
                      ? projectTexts.generation.chooseVideoProvider
                      : undefined
                }
                value={providerSelected ? value.provider : ''}
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                onChange={(event) => {
                  setCapabilities(null);
                  const provider = event.target.value;
                  if (!provider || provider === value.provider) return patch({ provider_selected: Boolean(provider) });
                  // Другой провайдер: всё, что от него зависит, заменяется значениями нового; требования проекта сохраняются.
                  onChange(switchGenerationProvider('video', value, provider));
                }}
                size="small"
              >
                <MenuItem value="">{commonTexts.notSelected}</MenuItem>
                {value.provider && !isMediaProvider(value.provider, 'video') && (
                  <MenuItem value={value.provider}>{projectTexts.generation.fromFile(value.provider || commonTexts.notSpecified)}</MenuItem>
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
                label={projectTexts.generation.preferredVideoModel}
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
                    renderValue: () =>
                      value.model
                        ? projectTexts.generation.modelChoice({ model: value.model, available: availableModels.includes(value.model) })
                        : defaultModelLabel
                  }
                }}
                helperText={modelError ? projectTexts.generation.modelUnavailable({ model: value.model }) : projectTexts.generation.modelHelp}
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
              <TextField
                select
                label={projectTexts.generation.videoResolution}
                value={value.resolution}
                onChange={(event) => patch({ resolution: event.target.value })}
                size="small"
                error={resolutionError}
                helperText={
                  !value.resolution.trim()
                    ? projectTexts.generation.chooseVideoResolution
                    : resolutionError
                      ? projectTexts.generation.resolutionUnsupported({ resolution: value.resolution, preferredModel: Boolean(value.model) })
                      : projectTexts.generation.videoResolutionHelp
                }
              >
                {!resolutions.includes(value.resolution) && (
                  <MenuItem value={value.resolution} disabled>
                    {projectTexts.generation.resolutionUnavailable(value.resolution || commonTexts.notSpecified)}
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
                label={projectTexts.generation.videoAspect}
                error={aspectError}
                value={selectedAspect}
                onChange={(event) => patch({ aspect_ratio: event.target.value })}
                size="small"
                slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
                helperText={
                  !selectedAspect.trim()
                    ? projectTexts.generation.chooseVideoAspect
                    : aspectError
                      ? projectTexts.generation.aspectUnsupported({ aspect: selectedAspect, preferredModel: Boolean(value.model) })
                      : projectTexts.generation.videoAspectHelp
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
                select
                label={projectTexts.generation.durationRule}
                error={durationError}
                value={value.duration_rule}
                onChange={(event) => patch({ duration_rule: event.target.value as Settings['duration_rule'] })}
                size="small"
                sx={{ gridColumn: '1 / -1' }}
                helperText={durationError ? projectTexts.generation.chooseDurationRule : projectTexts.generation.durationRuleHelp}
              >
                {!DURATION_RULES.includes(value.duration_rule) && (
                  <MenuItem value={value.duration_rule}>{projectTexts.generation.fromFile(value.duration_rule || commonTexts.notSpecified)}</MenuItem>
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
            {commonTexts.add}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
