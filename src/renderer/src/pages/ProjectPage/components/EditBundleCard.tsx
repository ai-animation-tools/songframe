/** Пакет для монтажёра: выбор папки, копирование медиа, запуск export_edit_bundle и список собранных пакетов. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, Paper, Stack, TextField, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InventoryIcon from '@mui/icons-material/Inventory';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import BuildIcon from '@mui/icons-material/Build';
import type { BundleInfo, JobInfo } from '@shared/types';
import { joinPath } from '../../../format';
import { useApp } from '../../../state';
import { ActionButton, DateTime, JobStatus } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';

function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function EditBundleCard({ project, pythonAvailable }: { project: string; pythonAvailable: boolean }): ReactElement {
  const { notify, describeError } = useApp();
  const [target, setTarget] = useState(() => joinPath(project, 'plan', 'batches', `edit-bundle-${stamp()}`));
  const [copy, setCopy] = useState(true);
  const [bundles, setBundles] = useState<BundleInfo[]>([]);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingBundle, setDeletingBundle] = useState<string | null>(null);
  const removingBundle = useRef(false);

  const load = useCallback(async () => setBundles(await window.api.production.listBundles(project)), [project]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  // После завершения задания обновляем список пакетов; подробный журнал остаётся на общей странице.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const handle = setInterval(async () => {
      const next = await window.api.jobs.get(job.id);
      if (next) setJob(next);
      if (next && next.status !== 'running') {
        await load();
        notify(next.status === 'done' ? 'Пакет для монтажёра собран' : 'Сборка пакета завершилась с ошибкой', next.status === 'done' ? 'success' : 'error');
      }
    }, 1500);
    return () => clearInterval(handle);
  }, [job, load, notify]);

  const pickFolder = async (): Promise<void> => {
    const folder = await window.api.dialog.pickFolder({ title: 'Где создать папку пакета (вне проекта)' });
    if (folder) setTarget(joinPath(folder, `edit-bundle-${stamp()}`));
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      setJob(await window.api.production.exportBundle(project, { target, copy }));
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const summary = job?.status === 'done' ? parseSummary(job.log) : null;
  // Сборка и удаление пакетов не идут одновременно: обе операции меняют plan/batches.
  const operationReason =
    job?.status === 'running'
      ? 'Дождитесь окончания сборки пакета.'
      : busy
        ? 'Дождитесь запуска сборки.'
        : deletingBundle !== null
          ? 'Дождитесь удаления пакета.'
          : null;
  const buildReason = operationReason ?? (!pythonAvailable ? 'Нужен Python: проверьте его на странице «Среда».' : null);

  /** Удаляем папку собранного пакета вместе с копиями; исходники проекта остаются на месте. */
  const removeBundle = async (bundle: BundleInfo): Promise<void> => {
    if (removingBundle.current) return;
    removingBundle.current = true;
    setDeletingBundle(bundle.dir);
    try {
      await window.api.production.removeBundle(project, bundle.dir);
      setBundles((current) => current.filter((item) => item.dir !== bundle.dir));
      // Сводка удалённого результата больше не предлагает открыть несуществующую папку.
      if (summary?.target === bundle.dir) setJob(null);
      await load();
      notify('Пакет для монтажёра удалён', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      removingBundle.current = false;
      setDeletingBundle(null);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <InventoryIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          Пакет для монтажёра
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Таблица планов с таймкодами песни и выбранными участками оригиналов, EDL, FCPXML с точной шкалой аниматика, строки песни и README. С копированием медиа
        в пакет попадают оригиналы, принятые клипы, опоры, промпты, WAV, карточки неготовых планов, референсы и песня; без копирования пути относительны
        проекту. Неготовые планы идут карточками.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField
          label="Папка пакета"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          sx={{ flex: 1, minWidth: 320 }}
          helperText="Пустая папка: внутри проекта только в plan/batches, иначе любая вне проекта"
        />
        <Button variant="outlined" startIcon={<FolderOpenIcon />} onClick={pickFolder} sx={{ mt: 0.25 }}>
          Вне проекта
        </Button>
      </Box>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mt: 1 }}>
        <FormControlLabel control={<Checkbox checked={copy} onChange={(e) => setCopy(e.target.checked)} />} label="Скопировать медиа в пакет" />
        <ActionButton
          variant="contained"
          disabled={busy || deletingBundle !== null || !pythonAvailable || job?.status === 'running'}
          disabledReason={buildReason}
          onClick={run}
          startIcon={job?.status === 'running' ? <CircularProgress size={16} color="inherit" /> : <BuildIcon />}
        >
          {job?.status === 'running' ? 'Собираем' : 'Собрать пакет'}
        </ActionButton>
      </Box>
      {job ? (
        <Box sx={{ mt: 1.5 }}>
          {job.status === 'failed' ? <Alert severity="error">Сборка не удалась, подробности в журнале заданий.</Alert> : null}
          {summary ? (
            <Alert
              severity="success"
              action={
                <Button
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  onClick={() => window.api.shell.openPath(summary.target).catch((error) => notify(describeError(error), 'error'))}
                >
                  Открыть папку
                </Button>
              }
            >
              Планов {summary.shots}, из них видео {summary.videos}, скопировано файлов {summary.copied}.
            </Alert>
          ) : null}
          <JobStatus running={job.status === 'running'} />
        </Box>
      ) : null}
      {bundles.length ? (
        <Stack spacing={0.5} sx={{ mt: 2 }}>
          <Typography variant="subtitle2">Собранные пакеты в plan/batches</Typography>
          {bundles.map((b) => (
            <Box key={b.dir} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }} noWrap title={b.dir}>
                {b.dir.split(/[\\/]/).pop()}
              </Typography>
              <Chip size="small" variant="outlined" label={`${b.videos} видео из ${b.shots}`} />
              {b.copied ? <Chip size="small" variant="outlined" label="с медиа" /> : null}
              <Typography variant="caption" color="text.secondary">
                {b.createdAt ? <DateTime value={b.createdAt} /> : ''}
              </Typography>
              <Button
                size="small"
                startIcon={<FolderOpenIcon />}
                onClick={() => window.api.shell.openPath(b.dir).catch((error) => notify(describeError(error), 'error'))}
              >
                Открыть
              </Button>
              <DestructiveButton
                icon
                label="Удалить пакет для монтажёра"
                description={`Будет удалена папка «${b.dir.split(/[\\/]/).pop()}» со всем содержимым, включая скопированные медиа. Исходные файлы проекта сохранятся.`}
                disabled={deletingBundle !== null || busy || job?.status === 'running'}
                disabledReason={operationReason}
                onConfirm={() => void removeBundle(b)}
              >
                <DeleteOutlineIcon fontSize="small" />
              </DestructiveButton>
            </Box>
          ))}
        </Stack>
      ) : null}
    </Paper>
  );
}

/** Вывод export_edit_bundle это JSON со сводкой; берём последний объект из журнала задания. */
function parseSummary(log: string): { target: string; shots: number; videos: number; copied: number } | null {
  const match = log.match(/\{[^{}]*"target"[^{}]*\}/g);
  if (!match) return null;
  try {
    const data = JSON.parse(match[match.length - 1]) as { target: string; shots: number; videos: number; copied_files: number };
    return { target: data.target, shots: data.shots, videos: data.videos, copied: data.copied_files };
  } catch {
    return null;
  }
}
