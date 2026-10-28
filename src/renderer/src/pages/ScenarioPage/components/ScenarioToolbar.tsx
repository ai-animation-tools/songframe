import BuildIcon from '@mui/icons-material/Build';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { ReactElement } from 'react';
import { Box, Button, Chip, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import SaveIcon from '@mui/icons-material/Save';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ScenesFile, TreatmentFile } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { SCENE_PROBLEMS_ID, type ScenarioTab } from '../types';

const BUSY_REASON = 'Дождитесь завершения текущей операции.';

/** Управляет вкладками и доступностью сохранения и построения каркаса. */
export function ScenarioToolbar({
  tab,
  onTabChange,
  treatment,
  scenes,
  busy,
  hasTiming,
  scaffoldProblem,
  treatmentDirty,
  scenesDirty,
  problems,
  showGlobal,
  onToggleGlobal,
  partsFromTiming,
  saveTreatment,
  saveScenes,
  scaffold
}: {
  tab: ScenarioTab;
  onTabChange(tab: ScenarioTab): void;
  treatment: TreatmentFile | null;
  scenes: ScenesFile | null;
  busy: boolean;
  hasTiming: boolean;
  scaffoldProblem: string | null;
  treatmentDirty: boolean;
  scenesDirty: boolean;
  problems: string[];
  showGlobal: boolean;
  onToggleGlobal(): void;
  partsFromTiming(): void;
  saveTreatment(): Promise<void>;
  saveScenes(): Promise<void>;
  scaffold(force: boolean): Promise<void>;
}): ReactElement {
  const dirty = tab === 'treatment' ? treatmentDirty : scenesDirty;
  const sceneProblems = tab === 'scenes' && scenes ? problems.length : 0;
  const saveDisabled = busy || (tab === 'treatment' ? !treatment || !treatmentDirty : !scenes || !scenesDirty || problems.length > 0);
  // Причина недоступности сохранения видна в подсказке, даже если список проблем прокручен из вида.
  const saveReason = busy
    ? BUSY_REASON
    : sceneProblems && scenesDirty
      ? `Исправьте проблемы реестра: ${sceneProblems}.`
      : dirty
        ? null
        : 'Нет изменений для сохранения.';
  const timingReason = busy ? BUSY_REASON : 'На странице «Тайминги» разметьте строки песни и сохраните результат.';
  const scaffoldDisabled = busy || !!scaffoldProblem;
  const scaffoldReason = busy ? BUSY_REASON : scaffoldProblem;
  return (
    <>
      <Typography variant="h5">Сценарий</Typography>
      <Tabs value={tab} onChange={(_e, v) => onTabChange(v)} sx={{ minHeight: 36 }}>
        <Tab value="treatment" label={`Трактовка${treatment ? ` · ${treatment.sequences.length}` : ''}`} sx={{ minHeight: 36 }} />
        <Tab value="scenes" label={`Реестр сцен${scenes ? ` · ${scenes.scenes.length}` : ''}`} sx={{ minHeight: 36 }} disabled={!scenes} />
      </Tabs>
      {dirty ? <Chip size="small" color="warning" label="Есть несохранённые правки" /> : null}
      {sceneProblems ? (
        <Chip
          size="small"
          color="error"
          variant="outlined"
          label={`Проблем: ${sceneProblems}`}
          onClick={() => document.getElementById(SCENE_PROBLEMS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        />
      ) : null}
      {/* Группа действий прижата вправо и при переносе: «Сохранить» всегда последняя справа. */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {tab === 'treatment' ? (
          <>
            {/* Повторное построение заменяет целиком части трактовки, сохраняя только логлайн. */}
            {treatment ? (
              <DestructiveButton
                label="Заменить части трактовки по разметке"
                description="Текущие части трактовки будут заменены частями из разметки. Их описания, участники и настройки будут потеряны. Логлайн сохранится; для записи результата в проект нужно сохранить трактовку."
                disabled={busy || !hasTiming}
                disabledReason={timingReason}
                size="medium"
                startIcon={<TimelineIcon />}
                onConfirm={partsFromTiming}
                confirmLabel="Заменить части"
              >
                Части из разметки
              </DestructiveButton>
            ) : (
              <ActionButton startIcon={<TimelineIcon />} onClick={partsFromTiming} disabled={busy || !hasTiming} disabledReason={timingReason}>
                Части из разметки
              </ActionButton>
            )}
            {scenes ? (
              // Назначение показывается у доступной кнопки; у выключенной подсказку с причиной даёт сама кнопка.
              <Tooltip title={scaffoldDisabled ? '' : 'Реестр уже есть: каркас заменит постановку всех планов'}>
                <span>
                  <DestructiveButton
                    label="Пересобрать каркас"
                    description="Реестр в plan/scenes.json будет сразу перезаписан каркасом по сохранённой трактовке и разметке. Постановка всех планов будет заменена; несохранённые изменения трактовки и реестра также будут потеряны."
                    disabled={scaffoldDisabled}
                    disabledReason={scaffoldReason}
                    size="medium"
                    startIcon={<BuildIcon />}
                    onConfirm={() => {
                      void scaffold(true);
                    }}
                    confirmLabel="Пересобрать"
                  />
                </span>
              </Tooltip>
            ) : (
              <ActionButton
                title="Создать начальный список планов по сохранённой трактовке и разметке песни"
                startIcon={<BuildIcon />}
                disabled={scaffoldDisabled}
                disabledReason={scaffoldReason}
                onClick={() => scaffold(false)}
              >
                Построить каркас
              </ActionButton>
            )}
          </>
        ) : (
          <Button endIcon={<ExpandMoreIcon sx={{ transform: showGlobal ? 'rotate(180deg)' : 'none' }} />} onClick={() => onToggleGlobal()}>
            Общие правила и части
          </Button>
        )}
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={saveDisabled}
          disabledReason={saveReason}
          onClick={() => void (tab === 'treatment' ? saveTreatment() : saveScenes())}
        >
          Сохранить
        </ActionButton>
      </Box>
    </>
  );
}
