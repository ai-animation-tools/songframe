/** Дашборд сцен: сводка, шкала, сетка карточек и подробности плана: оригинал против монтажа, опоры, промпт, состояние до и после. */

import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import type { DashboardView } from '@shared/types';
import { useApp } from '../../state';
import { SceneCard, ScenesSummary, ScenesTimeline, ShotDetails } from './components';
import type { Filter } from './types';
import { PageActionBar } from '../../components/PageActionBar';
import ReplayIcon from '@mui/icons-material/Replay';
import MovieIcon from '@mui/icons-material/Movie';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import DeselectIcon from '@mui/icons-material/Deselect';

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

  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<ReplayIcon />} onClick={load}>
            Повторить
          </Button>
        }
      >
        {loadError}
      </Alert>
    );
  if (!view) return <Typography color="text.secondary">Собираем сводку по сценам…</Typography>;
  const { summary } = view;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <ScenesSummary summary={summary} onRefresh={load} />
        {/* Выбор для пробы независим от открытой карточки: сцены попадут в монтаж в порядке песни. */}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Button
            startIcon={<MovieIcon />}
            variant="outlined"
            disabled={!montageShots.length}
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
            Монтаж выбранных ({montageShots.length})
          </Button>
          <Button
            startIcon={<SelectAllIcon />}
            size="small"
            disabled={!visible.length}
            onClick={() => setMontageShots((current) => [...new Set([...current, ...visible.map((item) => item.id)])])}
          >
            Отметить видимые
          </Button>
          <Button startIcon={<DeselectIcon />} size="small" disabled={!montageShots.length} onClick={() => setMontageShots([])}>
            Снять отметки
          </Button>
        </Stack>
      </PageActionBar>
      {view.problems.length ? (
        <Alert severity="warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {view.problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
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
                label={<Typography variant="caption">В монтажную пробу</Typography>}
              />
              <SceneCard shot={s} selected={selected === s.id} onSelect={select} />
            </Box>
          ))}
          {!visible.length ? <Typography color="text.secondary">Ничего не найдено.</Typography> : null}
        </Box>
        {shot ? (
          <ShotDetails
            key={shot.id}
            shot={shot}
            onOpen={(path) => window.api.shell.openPath(path).catch((error) => notify(describeError(error), 'error'))}
            onNavigate={(to) => navigate(to)}
            onClose={() => setParams({}, { replace: true })}
          />
        ) : null}
      </Box>
    </Stack>
  );
}
