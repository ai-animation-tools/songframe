import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import StraightenIcon from '@mui/icons-material/Straighten';
import type { ReactElement } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import SaveIcon from '@mui/icons-material/Save';
import SaveAsIcon from '@mui/icons-material/SaveAs';
import type { ScenesFile, ScenesSaveMode } from '@shared/types';
import { KEEP_NOTHING_REASON, SCENE_PROBLEMS_ID } from '../types';

const BUSY_REASON = commonTexts.operationPending;

/** Панель сценария: признак правок, число проблем, пересчёт границ и сохранение одного документа. */
export function ScenarioToolbar({
  scenes,
  busy,
  hasShots,
  scenesDirty,
  referencesStale,
  problems,
  saveScenes,
  keepUseless,
  boundsProblem,
  recalculateBounds
}: {
  scenes: ScenesFile | null;
  busy: boolean;
  /** В сценарии есть планы: без них проблемы частей не мешают сохранению, а пересчитывать нечего. */
  hasShots: boolean;
  scenesDirty: boolean;
  /** Карта references сценария устарела после изменения кастинга: сохранение доступно без правок и обновит её. */
  referencesStale: boolean;
  problems: string[];
  /** production — обычное сохранение, keep — «Сохранить без производства»; диалог с затронутыми планами показывает страница. */
  saveScenes(mode: ScenesSaveMode): Promise<void>;
  /** По последнему расчёту черновик не затрагивает планы с принятым комплектом или пакетом. */
  keepUseless: boolean;
  /** Причина, по которой границы сейчас не пересчитать (нет разметки, кастинга, частей или есть несохранённые правки). */
  boundsProblem: string | null;
  /** Окна планов по сохранённым частям и разметке — в черновик сценария, постановка прежняя. */
  recalculateBounds(): Promise<void>;
}): ReactElement {
  // Устаревшая карта референсов — тоже повод сохранить сценарий: её обновляет только запись.
  const savable = scenesDirty || (hasShots && referencesStale);
  const shownProblems = scenes ? problems.length : 0;
  // Сценарий из одних частей сохраняется черновиком и с проблемами; с планами проблемы надо исправить.
  const blocking = hasShots ? shownProblems : 0;
  const saveDisabled = busy || !scenes || !savable || blocking > 0;
  // Причина недоступности сохранения видна в подсказке, даже если список проблем прокручен из вида.
  const saveReason = busy
    ? BUSY_REASON
    : blocking && savable
      ? scenarioTexts.toolbar.fixRegistry({ count: blocking })
      : savable
        ? null
        : scenarioTexts.toolbar.noChanges;
  // «Без производства» имеет смысл, только когда сохранение затрагивает планы с материалами.
  const keepDisabled = saveDisabled || keepUseless;
  const keepReason = saveReason ?? (keepUseless ? KEEP_NOTHING_REASON : null);
  return (
    <>
      <Typography variant="h5">{navigationTexts.pages.scenario}</Typography>
      {scenesDirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
      {shownProblems ? (
        <Chip
          size="small"
          color="error"
          variant="outlined"
          label={scenarioTexts.toolbar.problems({ count: shownProblems })}
          onClick={() => document.getElementById(SCENE_PROBLEMS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        />
      ) : null}
      {/* Группа действий прижата вправо и при переносе: «Сохранить» всегда последняя справа. */}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {hasShots ? (
          <>
            <ActionButton
              title={scenarioTexts.toolbar.recalculateBoundsHint}
              startIcon={<StraightenIcon />}
              disabled={busy || !!boundsProblem}
              disabledReason={busy ? BUSY_REASON : boundsProblem}
              onClick={() => void recalculateBounds()}
            >
              {scenarioTexts.toolbar.recalculateBounds}
            </ActionButton>
            <ActionButton
              title={scenarioTexts.toolbar.saveWithoutProductionHint}
              startIcon={<SaveAsIcon />}
              disabled={keepDisabled}
              disabledReason={keepReason}
              onClick={() => void saveScenes('keep')}
            >
              {scenarioTexts.toolbar.saveWithoutProduction}
            </ActionButton>
          </>
        ) : null}
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={saveDisabled}
          disabledReason={saveReason}
          onClick={() => void saveScenes('production')}
        >
          {commonTexts.save}
        </ActionButton>
      </Box>
    </>
  );
}
