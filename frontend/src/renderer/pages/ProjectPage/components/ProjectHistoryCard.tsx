/**
 * История проекта на странице «Проект»: точки сохранения в Git (window.api.projectHistory).
 * Показывается, только если папка проекта — корень репозитория и Git установлен. Заметный статус
 * говорит, что не сохранено (по разделам приложения, со ссылками на их страницы) или что всё
 * сохранено; «Сохранить точку» коммитит изменения с подписью, предложенной по разделам. Список
 * последних точек позволяет сравнить сценарий точки с текущим и вернуть раздел-источник к точке.
 * Данные перечитываются при обновлении статуса проекта (фокус окна, окончание заданий).
 */
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Chip, List, ListItem, ListItemText, Menu, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import SaveIcon from '@mui/icons-material/Save';
import RestoreIcon from '@mui/icons-material/Restore';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { navigationTexts } from '@shared/texts/navigation';
import { projectTexts } from '@shared/texts/project';
import type { ProjectHistoryStatus, ProjectPoint, ProjectScenarioComparison, ProjectSection, RestorableSection } from '@shared/types';
import { ActionButton, DateTime } from '../../../components';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { formatDateTime } from '../../../format';
import { shotPageRoute } from '../../../components/shotRoutes';
import { useApp } from '../../../state';

const texts = projectTexts.history;

/** Подпись и страница раздела; страница нужна для перехода к месту изменений. */
const SECTION_INFO: Record<ProjectSection, { label: string; to?: string }> = {
  project: { label: navigationTexts.pages.project, to: '/project' },
  sources: { label: navigationTexts.pages.sources, to: '/project/sources' },
  timing: { label: navigationTexts.pages.timing, to: '/project/timing' },
  cast: { label: navigationTexts.pages.cast, to: '/project/cast' },
  scenario: { label: navigationTexts.pages.scenario, to: '/project/scenario' },
  production: { label: navigationTexts.pages.production, to: '/project/production' },
  scenes: { label: navigationTexts.pages.scenes, to: '/project/scenes' },
  montage: { label: navigationTexts.pages.montage, to: '/project/montage' },
  animatic: { label: navigationTexts.pages.animatic, to: '/project/animatic' },
  prompts: { label: navigationTexts.pages.prompts, to: '/project/prompts' },
  views: { label: texts.sections.views, to: '/project/checks' },
  other: { label: texts.sections.other }
};

/** Разделы, которые можно вернуть к точке, в порядке меню. */
const RESTORABLE: RestorableSection[] = ['scenario', 'timing', 'cast'];

export const sectionLabel = (section: ProjectSection): string => SECTION_INFO[section].label;

/** Подпись точки по умолчанию: изменённые разделы без производных и прочих файлов, если есть другие. */
export function defaultMessage(sections: ProjectSection[]): string {
  const meaningful = sections.filter((section) => section !== 'views' && section !== 'other');
  return (meaningful.length ? meaningful : sections).map(sectionLabel).join(', ');
}

/** Разделы ссылками на свои страницы (кроме «Прочих файлов»). */
function SectionChips({ sections }: { sections: ProjectSection[] }): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {sections.map((section) => {
        const info = SECTION_INFO[section];
        return info.to ? (
          <Chip key={section} size="small" variant="outlined" label={info.label} component={RouterLink} to={info.to} clickable />
        ) : (
          <Chip key={section} size="small" variant="outlined" label={info.label} />
        );
      })}
    </Box>
  );
}

/** Окно подписи новой точки. */
function SaveDialog({
  project,
  sections,
  onClose,
  onSaved
}: {
  project: string;
  sections: ProjectSection[];
  onClose(): void;
  onSaved(status: ProjectHistoryStatus): void;
}): ReactElement {
  const { notify, describeError } = useApp();
  const [message, setMessage] = useState(() => defaultMessage(sections));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const status = await window.api.projectHistory.save(project, message);
      notify(texts.saved, 'success');
      onSaved(status);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmationDialog
      open
      title={texts.saveTitle}
      onClose={onClose}
      onConfirm={() => void save()}
      confirmLabel={texts.save}
      confirmIcon={<SaveIcon />}
      confirmDisabled={busy || !message.trim()}
      confirmDisabledReason={busy ? texts.waitSaving : texts.messageRequired}
      closeDisabled={busy}
      cancelDisabled={busy}
      cancelDisabledReason={texts.waitSaving}
    >
      <TextField
        autoFocus
        required
        fullWidth
        label={texts.messageLabel}
        helperText={texts.messageHelp}
        value={message}
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
        sx={{ mt: 1 }}
      />
      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}
    </ConfirmationDialog>
  );
}

/** Сравнение сценария точки с текущим; из него же можно вернуть сценарий. */
function CompareDialog({ project, point, onClose, onRestore }: { project: string; point: ProjectPoint; onClose(): void; onRestore(): void }): ReactElement {
  const { describeError } = useApp();
  const [comparison, setComparison] = useState<ProjectScenarioComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    window.api.projectHistory
      .compareScenario(project, point.id)
      .then((next) => active && setComparison(next))
      .catch((reason: unknown) => active && setError(describeError(reason)));
    return () => {
      active = false;
    };
  }, [project, point.id, describeError]);
  const same = comparison && !comparison.missing && !comparison.shots.length && !comparison.removed.length;
  return (
    <ConfirmationDialog
      open
      title={texts.compareTitle({ message: point.message })}
      onClose={onClose}
      onConfirm={onRestore}
      confirmLabel={texts.restoreScenario}
      confirmIcon={<RestoreIcon />}
      confirmColor="warning"
      confirmDisabled={!comparison || comparison.missing || Boolean(same)}
      cancelLabel={projectTexts.history.compareCloseLabel}
      contentLabel={texts.compareTitle({ message: point.message })}
    >
      {error ? <Alert severity="error">{error}</Alert> : null}
      {comparison?.missing ? <Alert severity="info">{texts.compareMissing}</Alert> : null}
      {same ? <Alert severity="success">{texts.compareSame}</Alert> : null}
      {comparison && comparison.shots.length ? (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2">{texts.compareChanged}</Typography>
          <List dense disablePadding>
            {comparison.shots.map((shot) => (
              <ListItem key={shot.id} disableGutters>
                <ListItemText
                  primary={
                    <>
                      <RouterLink to={shotPageRoute('scenario', shot.id)}>{shot.id}</RouterLink> — {shot.reason}
                    </>
                  }
                  secondary={shot.produced ? texts.compareProduced : texts.comparePlanned}
                  slotProps={{ secondary: { color: shot.produced ? 'warning.main' : 'text.secondary' } }}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      ) : null}
      {comparison && comparison.removed.length ? (
        <Box>
          <Typography variant="subtitle2">{texts.compareRemoved}</Typography>
          <Typography variant="body2">{comparison.removed.join(', ')}</Typography>
        </Box>
      ) : null}
    </ConfirmationDialog>
  );
}

/** Строка точки: дата, подпись, разделы и действия. */
function PointRow({ point, onCompare, onRestore }: { point: ProjectPoint; onCompare(): void; onRestore(section: RestorableSection): void }): ReactElement {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <ListItem disableGutters divider sx={{ alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }} data-testid="project-point">
      <ListItemText
        primary={point.message}
        secondary={
          <Stack spacing={0.5} component="span">
            <span>
              <DateTime value={point.date} />
            </span>
            <SectionChips sections={point.sections} />
          </Stack>
        }
        slotProps={{ secondary: { component: 'div' } }}
        sx={{ minWidth: 220, flex: '1 1 260px' }}
      />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <ActionButton size="small" startIcon={<CompareArrowsIcon />} title={texts.compareHint} onClick={onCompare}>
          {texts.compare}
        </ActionButton>
        <ActionButton size="small" startIcon={<RestoreIcon />} title={texts.restoreHint} onClick={(event) => setMenu(event.currentTarget)}>
          {texts.restore}
        </ActionButton>
        <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
          {RESTORABLE.map((section) => (
            <MenuItem
              key={section}
              onClick={() => {
                setMenu(null);
                onRestore(section);
              }}
            >
              {texts.restoreSection({ section: sectionLabel(section) })}
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </ListItem>
  );
}

export function ProjectHistoryCard({ project, version }: { project: string; version: unknown }): ReactElement | null {
  const { refresh, notify, describeError } = useApp();
  const [status, setStatus] = useState<ProjectHistoryStatus | null>(null);
  const [points, setPoints] = useState<ProjectPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [comparing, setComparing] = useState<ProjectPoint | null>(null);
  const [restoring, setRestoring] = useState<{ point: ProjectPoint; section: RestorableSection } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.projectHistory.status(project);
      setStatus(next);
      setPoints(next.available ? await window.api.projectHistory.points(project) : []);
      setError(null);
    } catch (reason) {
      setError(texts.loadFailed({ reason: describeError(reason) }));
    }
  }, [project, describeError]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const restore = async (): Promise<void> => {
    if (!restoring) return;
    setRestoreBusy(true);
    const label = sectionLabel(restoring.section);
    try {
      const result = await window.api.projectHistory.restore(project, restoring.point.id, restoring.section);
      if (result.viewsError) notify(texts.viewsFailed({ reason: result.viewsError }), 'warning');
      else notify(texts.restored({ section: label }), 'success');
      setRestoring(null);
      setComparing(null);
      await refresh();
      await load();
    } catch (reason) {
      notify(describeError(reason), 'error');
    } finally {
      setRestoreBusy(false);
    }
  };

  if (error) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }} data-testid="project-history">
        <Alert severity="error">{error}</Alert>
      </Paper>
    );
  }
  if (!status?.available) return null;
  const dirty = status.sections.length > 0;
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="project-history">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <HistoryIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} component="h2" title={texts.hint} sx={{ flex: 1 }}>
          {texts.title}
        </Typography>
        <ActionButton
          variant="contained"
          size="small"
          startIcon={<SaveIcon />}
          title={texts.saveHint}
          disabled={!dirty}
          disabledReason={texts.nothingToSave}
          onClick={() => setSaving(true)}
        >
          {texts.save}
        </ActionButton>
      </Box>
      <Stack spacing={1}>
        {dirty ? (
          <Alert severity="warning">
            <Stack spacing={0.5}>
              <span>{texts.unsaved({ sections: status.sections.map(sectionLabel).join(', '), files: status.changedFiles })}</span>
              <SectionChips sections={status.sections} />
            </Stack>
          </Alert>
        ) : (
          <Alert severity="success">{texts.allSaved}</Alert>
        )}
        {status.autoError ? (
          <Alert severity="error" title={texts.autoFailed}>
            {status.autoError}
          </Alert>
        ) : null}
        {status.head ? (
          <Typography variant="body2" color="text.secondary">
            {texts.lastPoint({ message: status.head.message, date: formatDateTime(status.head.date) })}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {texts.noPoints}
          </Typography>
        )}
        {points.length ? (
          <Box>
            <Typography variant="subtitle2" sx={{ mt: 1 }}>
              {texts.points}
            </Typography>
            <List dense disablePadding sx={{ maxHeight: 420, overflowY: 'auto' }}>
              {points.map((point) => (
                <PointRow key={point.id} point={point} onCompare={() => setComparing(point)} onRestore={(section) => setRestoring({ point, section })} />
              ))}
            </List>
          </Box>
        ) : null}
      </Stack>
      {saving ? (
        <SaveDialog
          project={project}
          sections={status.sections}
          onClose={() => setSaving(false)}
          onSaved={(next) => {
            setSaving(false);
            setStatus(next);
            void load();
          }}
        />
      ) : null}
      {comparing ? (
        <CompareDialog
          project={project}
          point={comparing}
          onClose={() => setComparing(null)}
          onRestore={() => setRestoring({ point: comparing, section: 'scenario' })}
        />
      ) : null}
      {restoring ? (
        <ConfirmationDialog
          open
          title={texts.restoreSection({ section: sectionLabel(restoring.section) })}
          description={texts.restoreDescription({
            section: sectionLabel(restoring.section),
            message: restoring.point.message,
            date: formatDateTime(restoring.point.date)
          })}
          onClose={() => setRestoring(null)}
          onConfirm={() => void restore()}
          confirmLabel={texts.restore}
          confirmIcon={<RestoreIcon />}
          confirmColor="warning"
          confirmDisabled={restoreBusy}
          confirmDisabledReason={texts.waitRestoring}
          closeDisabled={restoreBusy}
          cancelDisabled={restoreBusy}
          cancelDisabledReason={texts.waitRestoring}
        >
          {restoring.section === 'scenario' ? <Alert severity="info">{texts.restoreScenarioNote}</Alert> : null}
        </ConfirmationDialog>
      ) : null}
    </Paper>
  );
}
