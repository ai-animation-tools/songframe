/** Настройки проекта из plan/project.json: имя MP4 аниматика и предпочтения генерации; название меняется кнопкой «Переименовать» в шапке. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { LinkedText } from '../../../components/LinkedText';
import { ANCHORS } from '../../../components/linkTargets';
import { Alert, Box, Paper, Stack, TextField, Typography } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { GenerationSettings, ProjectSettings } from '@shared/types';
import { DEFAULT_VIDEO_GENERATION, DEFAULT_IMAGE_GENERATION } from '@shared/types';
import { ActionButton } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { useApp } from '../../../state';

import { VideoGenerationSettings } from './VideoGenerationSettings';
import { ImageGenerationSettings } from './ImageGenerationSettings';

/** Пустой неподтверждённый черновик означает «Не выбрано»; старые настройки с именем провайдера не удаляются. */
export function normalizeProjectSettingsForSave(settings: ProjectSettings): ProjectSettings {
  if (!settings.generation) return settings;
  const normalize = <T extends GenerationSettings['image'] | GenerationSettings['video']>(block: T): T | null =>
    block && block.provider_selected !== true && typeof block.provider === 'string' && !block.provider.trim() ? null : block;
  return {
    ...settings,
    generation: { ...settings.generation, video: normalize(settings.generation.video), image: normalize(settings.generation.image) }
  };
}

export function ProjectSettingsCard({ project, name }: { project: string; name: string }): ReactElement {
  const { notify, describeError, refresh, invalidateAiAccess } = useApp();
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [form, setForm] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [videoValid, setVideoValid] = useState(true);
  const [imageValid, setImageValid] = useState(true);
  const previousName = useRef(name);

  const load = useCallback(async () => {
    try {
      const next = await window.api.projects.settings(project);
      setSaved(next);
      setForm(next);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [project, describeError]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const previous = previousName.current;
    previousName.current = name;
    if (name === previous) return;
    // Отдельное переименование обновляет только нетронутое имя, сохраняя остальные правки формы.
    setSaved((current) => (current ? { ...current, name } : current));
    setForm((current) => (current?.name === previous ? { ...current, name } : current));
  }, [name]);

  if (error && !form) return <Alert severity="error">{error}</Alert>;
  if (!form) return <Typography color="text.secondary">Читаем plan/project.json…</Typography>;

  const generation = form.generation;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const animaticError = !/^[\w.-]+\.mp4$/.test(form.animaticVideo) || form.animaticVideo.startsWith('.');
  const valid = !animaticError && videoValid && imageValid;
  const busyReason = busy ? 'Дождитесь окончания записи настроек.' : null;
  const noChangesReason = !dirty ? 'Нет изменений для сохранения.' : null;
  const saveReason = busyReason ?? noChangesReason ?? (!valid ? 'Исправьте ошибки в отмеченных полях формы.' : null);
  const setGeneration = (patch: Partial<GenerationSettings>): void => setForm({ ...form, generation: { video: null, image: null, ...generation, ...patch } });

  const save = async (): Promise<void> => {
    // Подсветка полей и возможность сохранить используют одно состояние валидации карточек.
    if (!valid || busy) return;
    // Пока запись не завершена, прежняя готовность AI не относится к новому состоянию проекта.
    invalidateAiAccess();
    setBusy(true);
    try {
      const next = await window.api.projects.saveSettings(project, normalizeProjectSettingsForSave(form));
      setSaved(next);
      setForm(next);
      notify('Настройки проекта записаны в plan/project.json', 'success');
    } catch (e) {
      notify(describeError(e), 'error');
    } finally {
      try {
        // После ошибки заново читаем фактические настройки и снимаем временную блокировку через общий refresh.
        await refresh();
      } catch (e) {
        notify(describeError(e), 'error');
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0, containerType: 'inline-size', containerName: 'project-settings' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
        <TuneIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          Настройки проекта
        </Typography>
        <Typography variant="caption" color="text.secondary">
          plan/project.json
        </Typography>
      </Box>
      <Stack spacing={1.5}>
        {/* Поля перестраиваются по ширине карточки, в том числе в боковой колонке проекта. */}
        <TextField
          label="Имя MP4 аниматика"
          slotProps={{ htmlInput: { 'data-anchor': ANCHORS.projectAnimaticName } }}
          value={form.animaticVideo}
          onChange={(e) => setForm({ ...form, animaticVideo: e.target.value })}
          size="small"
          sx={{ minWidth: 0, maxWidth: 480 }}
          error={animaticError}
          helperText={animaticError ? 'Укажите имя .mp4: буквы, цифры, точки и дефисы, без пути к папке.' : 'Без пути к папке'}
        />
        <VideoGenerationSettings
          key={`video:${project}`}
          project={project}
          value={generation?.video ?? null}
          onChange={(video) => setGeneration({ video })}
          onAdd={() => setGeneration({ video: { ...DEFAULT_VIDEO_GENERATION, provider: '' } })}
          onValidityChange={setVideoValid}
        />
        <ImageGenerationSettings
          key={`image:${project}`}
          project={project}
          value={generation?.image ?? null}
          onChange={(image) => setGeneration({ image })}
          onAdd={() => setGeneration({ image: { ...DEFAULT_IMAGE_GENERATION, provider: '' } })}
          onValidityChange={setImageValid}
        />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <ActionButton variant="contained" startIcon={<SaveIcon />} disabled={!dirty || busy || !valid} disabledReason={saveReason} onClick={save}>
            Сохранить
          </ActionButton>
          <DestructiveButton
            startIcon={<RestartAltIcon />}
            label="Сбросить правки настроек проекта"
            description="Все несохранённые изменения настроек будут потеряны. Форма вернётся к последним сохранённым значениям."
            disabled={!dirty || busy}
            disabledReason={busyReason ?? (!dirty ? 'Нет несохранённых правок.' : null)}
            onConfirm={() => setForm(saved)}
            confirmLabel="Сбросить правки"
          >
            Сбросить правки
          </DestructiveButton>
          <Typography variant="caption" color="text.secondary">
            Прочие поля файла сохраняются как есть. Изменение настроек не трогает уже подготовленные запросы: повтор по снимку с другим форматом остановится.
          </Typography>
        </Box>
        {!valid && (
          <Typography variant="caption" color="error">
            {/* Сообщение называет блоки с ошибками ссылками: переход прокручивает к блоку. */}
            <LinkedText
              text={`Исправьте ошибки перед сохранением: ${[
                animaticError ? 'поле «Имя MP4 аниматика»' : null,
                videoValid ? null : 'блок «Генерация видео»',
                imageValid ? null : 'блок «Генерация изображений»'
              ]
                .filter(Boolean)
                .join(', ')}.`}
            />
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
