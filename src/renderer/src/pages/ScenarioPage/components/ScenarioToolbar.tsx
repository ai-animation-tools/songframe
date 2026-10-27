import BuildIcon from '@mui/icons-material/Build';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { ReactElement } from 'react';
import { Box, Button, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ScenesFile, TreatmentFile } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { ScenarioTab } from '../types';

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
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="h5">Сценарий</Typography>
      <Tabs value={tab} onChange={(_e, v) => onTabChange(v)} sx={{ minHeight: 36 }}>
        <Tab value="treatment" label={`Трактовка${treatment ? ` · ${treatment.sequences.length}` : ''}`} sx={{ minHeight: 36 }} />
        <Tab value="scenes" label={`Реестр сцен${scenes ? ` · ${scenes.scenes.length}` : ''}`} sx={{ minHeight: 36 }} disabled={!scenes} />
      </Tabs>
      <Box sx={{ flex: 1 }} />
      {tab === 'treatment' ? (
        <>
          {/* Повторное построение заменяет целиком части трактовки, сохраняя только логлайн. */}
          {treatment ? (
            <DestructiveButton
              label="Заменить части трактовки по разметке"
              description="Текущие части трактовки будут заменены частями из разметки. Их описания, участники и настройки будут потеряны. Логлайн сохранится; для записи результата в проект нужно сохранить трактовку."
              disabled={busy || !hasTiming}
              onConfirm={partsFromTiming}
              confirmLabel="Заменить части"
            >
              Части из разметки
            </DestructiveButton>
          ) : (
            <Button startIcon={<TimelineIcon />} variant="outlined" onClick={partsFromTiming} disabled={busy || !hasTiming}>
              Части из разметки
            </Button>
          )}
          <Button variant="contained" startIcon={<SaveIcon />} disabled={busy || !treatment || !treatmentDirty} onClick={saveTreatment}>
            Сохранить
          </Button>
          <Tooltip
            title={
              scaffoldProblem ??
              (scenes ? 'Реестр уже есть: каркас заменит постановку всех планов' : 'Создать начальный список планов по сохранённой трактовке и разметке песни')
            }
          >
            <span>
              {scenes ? (
                <DestructiveButton
                  label="Пересобрать каркас"
                  description="Реестр в plan/scenes.json будет сразу перезаписан каркасом по сохранённой трактовке и разметке. Постановка всех планов будет заменена; несохранённые изменения трактовки и реестра также будут потеряны."
                  disabled={busy || !!scaffoldProblem}
                  onConfirm={() => {
                    void scaffold(true);
                  }}
                  confirmLabel="Пересобрать"
                />
              ) : (
                <Button startIcon={<BuildIcon />} variant="contained" color="success" disabled={busy || !!scaffoldProblem} onClick={() => scaffold(false)}>
                  Построить каркас
                </Button>
              )}
            </span>
          </Tooltip>
        </>
      ) : (
        <>
          <Button size="small" endIcon={<ExpandMoreIcon sx={{ transform: showGlobal ? 'rotate(180deg)' : 'none' }} />} onClick={() => onToggleGlobal()}>
            Общие правила и части
          </Button>
          <Button variant="contained" startIcon={<SaveIcon />} disabled={busy || !scenes || !scenesDirty || problems.length > 0} onClick={saveScenes}>
            Сохранить
          </Button>
        </>
      )}
      {tab === 'treatment' && scaffoldProblem && (
        <Typography variant="body2" color="text.secondary" sx={{ flexBasis: '100%' }}>
          {scaffoldProblem}
        </Typography>
      )}
    </Box>
  );
}
