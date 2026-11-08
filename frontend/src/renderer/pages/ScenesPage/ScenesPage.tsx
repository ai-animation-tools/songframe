import { scenesTexts } from '@shared/texts/scenes';
import { commonTexts } from '@shared/texts/common';
/** Дашборд сцен: сводка, шкала, сетка карточек и подробности плана: оригинал против монтажа, опоры, промпт, состояние до и после. */

import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { usePageLoading } from '../../components/PageLoader';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import type { DashboardView } from '@shared/types';
import { useApp } from '../../state';
import { SceneCard, ScenesSummary, ScenesTimeline, ShotDetails } from './components';
import type { Filter } from './types';
import { PageActionBar } from '../../components/PageActionBar';
import { ActionButton } from '../../components/ActionButton';
import ReplayIcon from '@mui/icons-material/Replay';
import RefreshIcon from '@mui/icons-material/Refresh';
import MovieIcon from '@mui/icons-material/Movie';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import DeselectIcon from '@mui/icons-material/Deselect';
import { LinkedText } from '../../components/LinkedText';
import { useStickyTop } from '../../hooks/useStickyTop';

export function ScenesPage(): ReactElement {
  const { state, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<DashboardView | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [montageShots, setMontageShots] = useState<string[]>([]);
  // Закреплённая панель выбранного плана стоит под шапкой и панелью действий; панель появляется после загрузки сводки.
  const { barRef, stickyTop } = useStickyTop([view]);
  useEffect(() => setMontageShots([]), [project]);
  const selected = params.get('shot');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setView(await window.api.dashboard.view(project));
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, [project, describeError]);
  useEffect(() => {
    void load();
  }, [load]);

  const shots = useMemo(() => view?.shots ?? [], [view]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return shots.filter(
      (s) => (filter === 'all' || s.state === filter) && (!needle || [s.id, s.title, s.original, s.action, s.camera].join(' ').toLowerCase().includes(needle))
    );
  }, [shots, filter, query]);
  const shot = shots.find((s) => s.id === selected) ?? null;
  const select = (id: string): void => setParams({ shot: id }, { replace: true });
  const duration = view?.summary.duration ?? 0;

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<ReplayIcon />} onClick={load}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );
  if (!view) return <></>;
  const { summary } = view;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar barRef={barRef}>
        <ScenesSummary summary={summary} />
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<RefreshIcon />} onClick={load}>
          {commonTexts.refresh}
        </Button>
        {/* Выбор для пробы независим от открытой карточки: сцены попадут в монтаж в порядке песни. */}
        <ActionButton
          startIcon={<MovieIcon />}
          variant="contained"
          disabled={!montageShots.length}
          disabledReason={scenesTexts.selectForMontage}
          onClick={() =>
            navigate(
              `/project/montage?shots=${encodeURIComponent(
                shots
                  .filter((item) => montageShots.includes(item.id))
                  .map((item) => item.id)
                  .join(',')
              )}`
            )
          }
        >
          {scenesTexts.montageSelected({ count: montageShots.length })}
        </ActionButton>
      </PageActionBar>
      {view.problems.length ? (
        <Alert severity="warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {view.problems.slice(0, 6).map((p) => (
              <li key={p}>
                <LinkedText text={p} />
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <ScenesTimeline
        shots={shots}
        selected={selected}
        filter={filter}
        query={query}
        duration={duration}
        visibleCount={visible.length}
        onSelect={select}
        onFilter={setFilter}
        onQuery={setQuery}
        actions={
          <>
            <ActionButton
              startIcon={<SelectAllIcon />}
              size="small"
              disabled={!visible.length}
              disabledReason={scenesTexts.noVisibleScenes}
              onClick={() => setMontageShots((current) => [...new Set([...current, ...visible.map((item) => item.id)])])}
            >
              {scenesTexts.markVisible}
            </ActionButton>
            <ActionButton
              startIcon={<DeselectIcon />}
              size="small"
              disabled={!montageShots.length}
              disabledReason={scenesTexts.noMarkedScenes}
              onClick={() => setMontageShots([])}
            >
              {scenesTexts.unmarkAll}
            </ActionButton>
          </>
        }
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container workspace (min-width: 1100px)': { gridTemplateColumns: shot ? 'minmax(0, 1fr) minmax(0, 1.4fr)' : 'minmax(0, 1fr)' },
          gap: 2,
          alignItems: 'start'
        }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: 1.5, minWidth: 0 }}>
          {visible.map((s) => (
            <Box key={s.id}>
              <FormControlLabel
                sx={{ ml: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={montageShots.includes(s.id)}
                    onChange={(event) => setMontageShots((current) => (event.target.checked ? [...current, s.id] : current.filter((id) => id !== s.id)))}
                  />
                }
                label={<Typography variant="caption">{scenesTexts.forMontage}</Typography>}
              />
              <SceneCard shot={s} selected={selected === s.id} onSelect={select} />
            </Box>
          ))}
          {!visible.length ? <Typography color="text.secondary">{scenesTexts.nothingFound}</Typography> : null}
        </Box>
        {shot ? (
          // Как на «Производстве»: при двух колонках выбранный план закреплён под панелью действий и прокручивается внутри себя.
          <Box
            sx={{
              minWidth: 0,
              '@container workspace (min-width: 1100px)': {
                position: 'sticky',
                top: stickyTop,
                maxHeight: `calc(100vh - ${stickyTop + 16}px)`,
                overflowY: 'auto',
                pr: 0.5
              }
            }}
          >
            <ShotDetails
              key={shot.id}
              shot={shot}
              onOpen={(path) => window.api.shell.openPath(path).catch((error) => notify(describeError(error), 'error'))}
              onNavigate={(to) => navigate(to)}
              onClose={() => setParams({}, { replace: true })}
            />
          </Box>
        ) : null}
      </Box>
    </Stack>
  );
}
