import { schemesTexts } from '@shared/texts/schemes';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertTitle, Box, Button, ButtonBase, Chip, Paper, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import type { SchemeViewKind, SchemesFile, SchemesView } from '@shared/schemes';
import { SCHEME_VIEWS } from '@shared/schemes';
import { createScheme, updateScheme } from '@shared/scheme-editing';
import { useApp } from '../../state';
import { RequestScope } from '../../hooks/requestScope';
import { useStickyTop } from '../../hooks/useStickyTop';
import { usePageLoading } from '../../components/PageLoader';
import { PageActionBar } from '../../components/PageActionBar';
import { ActionButton } from '../../components/ActionButton';
import { LinkedText } from '../../components/LinkedText';
import { ListDetailLayout } from '../../components/ListDetailLayout';
import { SchemeEditor } from './components/SchemeEditor';
import { DraftRestoreAlert } from '../../components/DraftRestoreAlert';
import { FullscreenEditorDialog } from '../../components/FullscreenEditorDialog';
import { useDraftBackup } from '../../hooks/useDraftBackup';

/** Параметры адреса: выбранная локация и вид, чтобы переход по ссылке открывал нужную схему. */
const LOCATION_PARAM = 'location';
const VIEW_PARAM = 'view';
/** Высота шапки окна во весь экран с отступом содержимого: от неё редактор считает высоту холста, px. */
const FULLSCREEN_TOP = 64;

/**
 * Страница «Схемы»: локации кастинга слева, схемы выбранной локации справа. Один черновик plan/schemes.json на всю
 * страницу; запись — кнопкой «Сохранить» после проверки в Go. Повреждённый файл показывается и не перезаписывается.
 */
export function SchemesPage(): ReactElement {
  const { state, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const scope = useRef(new RequestScope());
  scope.current.update(project);
  const [view, setView] = useState<SchemesView | null>(null);
  const [draft, setDraft] = useState<SchemesFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Редактор выбранной локации во весь экран: он показывается в окне вместо страницы, черновик тот же.
  const [fullscreen, setFullscreen] = useState(false);
  const [params, setParams] = useSearchParams();
  const { barRef, stickyTop } = useStickyTop([view]);

  const load = useCallback(async () => {
    const current = scope.current.capture(project);
    setLoadError(null);
    const next = await window.api.schemes.view(project);
    if (!current()) return;
    setView(next);
    setDraft(JSON.parse(JSON.stringify(next.document)) as SchemesFile);
  }, [project]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, describeError]);

  const locations = view?.locations ?? [];
  const locationId =
    params.get(LOCATION_PARAM) && locations.some((item) => item.id === params.get(LOCATION_PARAM)) ? params.get(LOCATION_PARAM)! : locations[0]?.id;
  const schemeView = (SCHEME_VIEWS as readonly string[]).includes(params.get(VIEW_PARAM) ?? '') ? (params.get(VIEW_PARAM) as SchemeViewKind) : 'top';
  const select = (location: string, kind: SchemeViewKind): void => {
    const next = new URLSearchParams(params);
    next.set(LOCATION_PARAM, location);
    next.set(VIEW_PARAM, kind);
    setParams(next, { replace: true });
  };
  const dirty = useMemo(() => !!view && !!draft && JSON.stringify(view.document) !== JSON.stringify(draft), [view, draft]);
  // Несохранённые схемы страхуются временным файлом вне клипа; повреждённый файл схем не перезаписывается и
  // не сравнивается с черновиком.
  const backup = useDraftBackup<SchemesFile | null>({
    project,
    kind: 'schemes',
    ready: !!view && !view.damaged,
    saved: view?.document ?? null,
    draft,
    dirty,
    onRestore: (document) => document && setDraft(document),
    onError: (message) => notify(message, 'warning')
  });

  /** Записывает черновик; true — записан (окно во весь экран после этого можно закрыть). */
  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    const current = scope.current.capture(project);
    setBusy(true);
    try {
      await window.api.schemes.save(project, draft);
      if (!current()) return false;
      await load();
      notify(schemesTexts.saved, 'success');
      return true;
    } catch (error) {
      notify(describeError(error), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={() => load().catch((error) => setLoadError(describeError(error)))}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );
  if (!view || !draft) return <></>;

  const location = locations.find((item) => item.id === locationId) ?? null;
  const saveBlocked = view.damaged ? schemesTexts.damaged : null;
  const saveButton = (
    <ActionButton
      variant="contained"
      startIcon={<SaveIcon />}
      disabled={busy || !dirty || !!saveBlocked}
      disabledReason={busy ? commonTexts.operationPending : !dirty ? commonTexts.noChangesToSave : saveBlocked}
      onClick={() => void save()}
    >
      {commonTexts.save}
    </ActionButton>
  );
  const editor = (inDialog: boolean): ReactElement | null =>
    location ? (
      <SchemeEditor
        key={location.id}
        location={location}
        entities={view?.entities ?? []}
        schemes={draft.schemes.filter((scheme) => scheme.location === location.id)}
        view={schemeView}
        onView={(kind) => select(location.id, kind)}
        onCreate={(kind, title) => setDraft({ ...draft, schemes: [...draft.schemes, createScheme(draft, location.id, kind, title)] })}
        onChange={(scheme) => setDraft((current) => (current ? updateScheme(current, scheme.id, () => scheme) : current))}
        onDelete={(scheme) => setDraft({ ...draft, schemes: draft.schemes.filter((item) => item.id !== scheme.id) })}
        onFullscreen={inDialog ? undefined : () => setFullscreen(true)}
        inDialog={inDialog}
        viewStorage={`songframe.schemes.view.${project}`}
        stickyTop={inDialog ? FULLSCREEN_TOP : stickyTop}
      />
    ) : null;
  return (
    <Stack spacing={2}>
      <PageActionBar barRef={barRef}>
        <Typography variant="h5">{navigationTexts.pages.schemes}</Typography>
        {dirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
        <Box sx={{ flex: 1 }} />
        {saveButton}
      </PageActionBar>
      {backup.offer ? <DraftRestoreAlert offer={backup.offer} onRestore={backup.restore} onDiscard={backup.discard} /> : null}
      {view.damaged ? <Alert severity="error">{schemesTexts.damaged}</Alert> : null}
      {view.problems.length && !view.damaged ? (
        <Alert severity="warning">
          <AlertTitle>{schemesTexts.problems}</AlertTitle>
          {view.problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </Alert>
      ) : null}
      {!locations.length ? (
        <Alert severity="info">
          <LinkedText text={schemesTexts.noLocations} />
        </Alert>
      ) : (
        <ListDetailLayout
          storageKey="songframe.schemes.list-width"
          defaultWidth={260}
          minDetailWidth={700}
          stickyTop={stickyTop}
          list={
            <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
              <Typography variant="subtitle2" sx={{ px: 1.5, pt: 1.5, pb: 0.5 }}>
                {schemesTexts.locations}
              </Typography>
              {locations.map((item) => {
                const own = draft.schemes.filter((scheme) => scheme.location === item.id);
                const hasTop = own.some((scheme) => scheme.view === 'top');
                const active = item.id === locationId;
                return (
                  <ButtonBase
                    key={item.id}
                    component="div"
                    data-location-id={item.id}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => select(item.id, 'top')}
                    sx={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      px: 1.5,
                      py: 0.75,
                      borderLeft: 3,
                      borderColor: active ? 'primary.main' : 'transparent',
                      bgcolor: active ? 'action.selected' : undefined,
                      '&:hover': { bgcolor: 'action.hover' },
                      '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
                    }}
                  >
                    <Typography fontWeight={600}>{item.name || item.id}</Typography>
                    {hasTop ? (
                      <Typography variant="caption" color="text.secondary">
                        {schemesTexts.viewsDone({ views: own.map((scheme) => schemesTexts.views[scheme.view].toLowerCase()).join(', ') })}
                      </Typography>
                    ) : (
                      <Chip size="small" color="warning" label={schemesTexts.withoutTop} sx={{ height: 18 }} />
                    )}
                  </ButtonBase>
                );
              })}
            </Paper>
          }
          detail={fullscreen ? null : editor(false)}
        />
      )}
      <FullscreenEditorDialog
        open={fullscreen && !!location}
        title={schemesTexts.fullscreenTitle({ location: location?.name || location?.id || '' })}
        dirty={dirty}
        actions={saveButton}
        onClose={() => setFullscreen(false)}
      >
        {fullscreen ? editor(true) : null}
      </FullscreenEditorDialog>
    </Stack>
  );
}
