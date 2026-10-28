/** Кастинг: сущности клипа, их изображения из исходников, роль, внешность и начальное состояние. */

import RefreshIcon from '@mui/icons-material/Refresh';
import { usePageLoading } from '../../components/PageLoader';
import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { DEFAULT_SOURCE_KINDS, type CastEntity, type CastFile, type CastView } from '@shared/types';
import { useApp } from '../../state';
import { CastEntityCard, CastToolbar } from './components';
import { WORLD } from './constants';
import { castImageOptions } from './helpers';
import { LinkedText } from '../../components/LinkedText';
import { ActionButton } from '../../components/ActionButton';

export function CastPage(): ReactElement {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<CastView | null>(null);
  const [cast, setCast] = useState<CastFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const next = await window.api.cast.view(project);
    setView(next);
    setCast(next.cast ? JSON.parse(JSON.stringify(next.cast)) : null);
  }, [project]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  const kinds = useMemo(() => {
    const fromManifest = view?.manifest?.kinds?.length ? view.manifest.kinds : DEFAULT_SOURCE_KINDS;
    const ids = new Set(fromManifest.map((k) => k.id));
    const extra = (cast?.entities ?? []).map((e) => e.kind).filter((k) => !ids.has(k) && k !== WORLD);
    return [...fromManifest, ...[...new Set(extra)].map((k) => ({ id: k, label: k, dir: k })), { id: WORLD, label: 'Мир сцены', dir: '' }];
  }, [view, cast]);
  const imageOptions = useMemo(() => castImageOptions(view?.manifest ?? null), [view]);
  const dirty = JSON.stringify(cast) !== JSON.stringify(view?.cast ?? null);

  const update = (id: string, patch: Partial<CastEntity>): void =>
    setCast((c) => c && { ...c, entities: c.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const remove = (id: string): void => setCast((c) => c && { ...c, entities: c.entities.filter((e) => e.id !== id) });
  const add = (): void => {
    // Количество записей не определяет свободный код после удаления сущностей.
    let number = 1;
    while (cast?.entities.some((entity) => entity.id === `entity_${number}`)) number += 1;
    const id = `entity_${number}`;
    setCast(
      (c) =>
        c && { ...c, entities: [...c.entities, { id, kind: kinds[0].id, name: '', short_name: '', role: '', appearance: '', images: [], initial_state: {} }] }
    );
    setExpanded(id);
  };

  const init = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api.cast.init(project);
      await load();
      await refresh();
      notify('Кастинг дополнен из исходников', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!cast) return;
    setBusy(true);
    try {
      await window.api.cast.save(project, cast);
      await load();
      await refresh();
      notify('Кастинг сохранён', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={() => load().catch((error) => setLoadError(describeError(error)))}>
            Повторить
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );

  if (!view) return <></>;

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0, pb: 8 }}>
      <CastToolbar busy={busy} dirty={dirty} hasManifest={Boolean(view.manifest)} hasCast={Boolean(cast)} onInit={init} onSave={save} />
      {view.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {!view.manifest ? (
        <Alert severity="info">
          <LinkedText text="Исходников ещё нет: загрузите референсы на странице «Исходники», затем создайте кастинг." />
        </Alert>
      ) : null}
      {!cast ? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography color="text.secondary">
            <LinkedText text="Кастинга пока нет. Он собирается из референсов исходников: каждый референс становится сущностью с кодом, типом и изображениями, плюс сущность «Мир сцены» для времени суток, погоды и сторон дороги. Роль, внешность и начальное состояние заполняются здесь или агентом: кнопка «Создать трактовку» на странице «Сценарий» готовит предложение кастинга вместе с трактовкой." />
          </Typography>
        </Paper>
      ) : (
        // Карточки занимают несколько колонок, раскрытый редактор использует всю строку.
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr)',
            '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
            gap: 1,
            alignItems: 'start'
          }}
        >
          {cast.entities.map((entity) => (
            <CastEntityCard
              key={entity.id}
              entity={entity}
              entities={cast.entities}
              kinds={kinds}
              properties={cast.properties[entity.kind] ?? []}
              imagePaths={view.imagePaths}
              imageOptions={imageOptions}
              expanded={expanded === entity.id}
              onExpandedChange={(open) => setExpanded(open ? entity.id : null)}
              onUpdate={(patch) => update(entity.id, patch)}
              onRename={(nextId) => {
                // Проверка выполняется до смены кода, чтобы не создать дубликат ключа карточки.
                if (cast.entities.some((other) => other !== entity && other.id === nextId)) {
                  notify('Этот код уже занят другой сущностью.', 'warning');
                  return;
                }
                update(entity.id, { id: nextId });
                setExpanded(nextId);
              }}
              onRemove={() => remove(entity.id)}
            />
          ))}
        </Box>
      )}
      {cast && (
        <Box>
          <ActionButton
            variant="outlined"
            color="success"
            startIcon={<AddIcon />}
            disabled={busy}
            disabledReason="Дождитесь завершения текущей операции."
            onClick={add}
          >
            Добавить сущность
          </ActionButton>
        </Box>
      )}
      <Typography variant="caption" color="text.secondary">
        Словарь свойств по типам хранится в plan/cast.json (раздел properties) и правится там; новые типы получают общий набор. Код сущности используется в
        реестре сцен, при переименовании сцены нужно обновить.
      </Typography>
    </Stack>
  );
}
