import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import BuildIcon from '@mui/icons-material/Build';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { ReactElement } from 'react';
import { Box, Button, Chip, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import SaveIcon from '@mui/icons-material/Save';
import SaveAsIcon from '@mui/icons-material/SaveAs';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ScenesFile, ScenesSaveMode, TreatmentFile } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { KEEP_NOTHING_REASON, SCENE_PROBLEMS_ID, type ScenarioTab } from '../types';

const BUSY_REASON = commonTexts.operationPending;

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
  keepUseless,
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
  /** production — обычное сохранение, keep — «Сохранить без производства»; диалог с затронутыми планами показывает страница. */
  saveScenes(mode: ScenesSaveMode): Promise<void>;
  /** По последнему расчёту черновик не затрагивает планы с принятым комплектом или пакетом. */
  keepUseless: boolean;
  scaffold(force: boolean): Promise<void>;
}): ReactElement {
  const dirty = tab === 'treatment' ? treatmentDirty : scenesDirty;
  const sceneProblems = tab === 'scenes' && scenes ? problems.length : 0;
  const saveDisabled = busy || (tab === 'treatment' ? !treatment || !treatmentDirty : !scenes || !scenesDirty || problems.length > 0);
  // Причина недоступности сохранения видна в подсказке, даже если список проблем прокручен из вида.
  const saveReason = busy
    ? BUSY_REASON
    : sceneProblems && scenesDirty
      ? scenarioTexts.toolbar.fixRegistry({ count: sceneProblems })
      : dirty
        ? null
        : scenarioTexts.toolbar.noChanges;
  // «Без производства» имеет смысл, только когда сохранение затрагивает планы с материалами.
  const keepDisabled = saveDisabled || keepUseless;
  const keepReason = saveReason ?? (keepUseless ? KEEP_NOTHING_REASON : null);
  const timingReason = busy ? BUSY_REASON : scenarioTexts.prerequisites.timing;
  const scaffoldDisabled = busy || !!scaffoldProblem;
  const scaffoldReason = busy ? BUSY_REASON : scaffoldProblem;
  return (
    <>
      <Typography variant="h5">{navigationTexts.pages.scenario}</Typography>
      <Tabs value={tab} onChange={(_e, v) => onTabChange(v)} sx={{ minHeight: 36 }}>
        <Tab value="treatment" label={scenarioTexts.toolbar.treatmentTab({ count: treatment ? treatment.sequences.length : null })} sx={{ minHeight: 36 }} />
        <Tab
          value="scenes"
          label={scenarioTexts.toolbar.scenesTab({ count: scenes ? scenes.scenes.length : null })}
          sx={{ minHeight: 36 }}
          disabled={!scenes}
        />
      </Tabs>
      {dirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
      {sceneProblems ? (
        <Chip
          size="small"
          color="error"
          variant="outlined"
          label={scenarioTexts.toolbar.problems({ count: sceneProblems })}
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
                label={scenarioTexts.toolbar.replaceParts}
                description={scenarioTexts.toolbar.replacePartsDescription}
                disabled={busy || !hasTiming}
                disabledReason={timingReason}
                size="medium"
                startIcon={<TimelineIcon />}
                onConfirm={partsFromTiming}
                confirmLabel={scenarioTexts.toolbar.replacePartsConfirm}
              >
                {scenarioTexts.toolbar.partsFromTiming}
              </DestructiveButton>
            ) : (
              <ActionButton startIcon={<TimelineIcon />} onClick={partsFromTiming} disabled={busy || !hasTiming} disabledReason={timingReason}>
                {scenarioTexts.toolbar.partsFromTiming}
              </ActionButton>
            )}
            {scenes ? (
              // Назначение показывается у доступной кнопки; у выключенной подсказку с причиной даёт сама кнопка.
              <Tooltip title={scaffoldDisabled ? '' : scenarioTexts.toolbar.scaffoldReplacesStaging}>
                <span>
                  <DestructiveButton
                    label={scenarioTexts.toolbar.rebuildScaffold}
                    description={scenarioTexts.toolbar.rebuildScaffoldDescription}
                    disabled={scaffoldDisabled}
                    disabledReason={scaffoldReason}
                    size="medium"
                    startIcon={<BuildIcon />}
                    onConfirm={() => {
                      void scaffold(true);
                    }}
                    confirmLabel={scenarioTexts.toolbar.rebuildConfirm}
                  />
                </span>
              </Tooltip>
            ) : (
              <ActionButton
                title={scenarioTexts.toolbar.buildScaffoldHint}
                startIcon={<BuildIcon />}
                disabled={scaffoldDisabled}
                disabledReason={scaffoldReason}
                onClick={() => scaffold(false)}
              >
                {scenarioTexts.toolbar.buildScaffold}
              </ActionButton>
            )}
          </>
        ) : (
          <Button endIcon={<ExpandMoreIcon sx={{ transform: showGlobal ? 'rotate(180deg)' : 'none' }} />} onClick={() => onToggleGlobal()}>
            {scenarioTexts.toolbar.globalRules}
          </Button>
        )}
        {tab === 'scenes' ? (
          <ActionButton
            title={scenarioTexts.toolbar.saveWithoutProductionHint}
            startIcon={<SaveAsIcon />}
            disabled={keepDisabled}
            disabledReason={keepReason}
            onClick={() => void saveScenes('keep')}
          >
            {scenarioTexts.toolbar.saveWithoutProduction}
          </ActionButton>
        ) : null}
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={saveDisabled}
          disabledReason={saveReason}
          onClick={() => void (tab === 'treatment' ? saveTreatment() : saveScenes('production'))}
        >
          {commonTexts.save}
        </ActionButton>
      </Box>
    </>
  );
}
