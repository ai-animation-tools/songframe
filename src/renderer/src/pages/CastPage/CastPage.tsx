import { sourcesTexts } from '@shared/texts/sources';
import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
/** Кастинг: сущности клипа, их изображения из исходников, роль, внешность и начальное состояние. */

import RefreshIcon from '@mui/icons-material/Refresh';
import { usePageLoading } from '../../components/PageLoader';
import AddIcon from '@mui/icons-material/Add';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { joinPath } from '../../format';
import { referenceImagePrompt } from '@shared/reference-image-generation';
import { ImageGenerateDialog } from '../../components/ImageGenerateDialog';
import { DEFAULT_SOURCE_KINDS, type CastEntity, type CastFile, type CastView } from '@shared/types';
import { useApp } from '../../state';
import { RequestScope } from '../../hooks/requestScope';
import { referenceImageOption } from '../../hooks/referenceImageOptions';
import { CastEmptyState, CastEntityCard, CastPropertiesEditor, CastToolbar } from './components';
import { WORLD } from './constants';
import { castImageOptions } from './helpers';
import { cleanProperties, dictionaryProblem } from './properties';
import { LinkedText } from '../../components/LinkedText';
import { ActionButton } from '../../components/ActionButton';
import { ENTITY_PARAM } from '../../components/castRoutes';
import { coveredArea, revealAnchor } from '../../hooks/useAnchorTarget';

export function CastPage(): ReactElement {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const projectScope = useRef(new RequestScope());
  projectScope.current.update(project);
  const projectCurrent = projectScope.current.capture(project);
  const [generationTarget, setGenerationTarget] = useState<{ project: string; entity: CastEntity } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<CastView | null>(null);
  const [cast, setCast] = useState<CastFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const entityParam = params.get(ENTITY_PARAM);
  // Сущность, к карточке которой после перехода (?entity=) нужно прокрутить; сбрасывается после прокрутки.
  const [revealEntity, setRevealEntity] = useState<string | null>(null);

  const load = useCallback(async () => {
    const current = projectScope.current.capture(project);
    try {
      setLoadError(null);
      const next = await window.api.cast.view(project);
      if (!current()) return;
      setView(next);
      setCast(next.cast ? JSON.parse(JSON.stringify(next.cast)) : null);
    } catch (failure) {
      // Ошибка прежнего проекта не должна скрывать уже открытый новый проект.
      if (current()) throw failure;
    }
  }, [project]);

  useEffect(() => {
    setView(null);
    setCast(null);
    setGenerationTarget(null);
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  // Переход с ?entity= (источник значения врезки на «Сценарии») раскрывает карточку сущности; параметр затем снимается.
  useEffect(() => {
    if (!entityParam || !cast) return;
    if (cast.entities.some((entity) => entity.id === entityParam)) {
      setExpanded(entityParam);
      setRevealEntity(entityParam);
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(ENTITY_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [entityParam, cast, setParams]);

  useEffect(() => {
    if (!revealEntity) return;
    const card = document.querySelector<HTMLElement>(`[data-cast-entity="${CSS.escape(revealEntity)}"]`);
    if (card) revealAnchor(card, coveredArea(document), window.innerHeight);
    setRevealEntity(null);
  }, [revealEntity]);

  const kinds = useMemo(() => {
    const fromManifest = view?.manifest?.kinds?.length ? view.manifest.kinds : DEFAULT_SOURCE_KINDS;
    const ids = new Set(fromManifest.map((k) => k.id));
    const extra = (cast?.entities ?? []).map((e) => e.kind).filter((k) => !ids.has(k) && k !== WORLD);
    return [...fromManifest, ...[...new Set(extra)].map((k) => ({ id: k, label: k, dir: k })), { id: WORLD, label: castTexts.world, dir: '' }];
  }, [view, cast]);
  const imageOptions = useMemo(() => castImageOptions(view?.manifest ?? null), [view]);
  const dirty = JSON.stringify(cast) !== JSON.stringify(view?.cast ?? null);
  const propertiesProblem = cast ? dictionaryProblem(cast.properties, (kind) => kinds.find((k) => k.id === kind)?.label ?? kind) : null;

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
      notify(castTexts.supplemented, 'success');
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
      // Пробелы по краям и пустые варианты словаря убираются при сохранении, а не во время ввода.
      await window.api.cast.save(project, { ...cast, properties: cleanProperties(cast.properties) });
      await load();
      await refresh();
      notify(castTexts.saved, 'success');
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
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );

  if (!view) return <></>;

  return (
    <Stack spacing={2} inert={busy || undefined} aria-busy={busy} sx={{ width: '100%', minWidth: 0, pb: 8 }}>
      <CastToolbar
        busy={busy}
        dirty={dirty}
        saveBlockedReason={propertiesProblem}
        hasManifest={Boolean(view.manifest)}
        hasCast={Boolean(cast)}
        onInit={init}
        onSave={save}
      />
      {cast && view.manifest ? (
        <Typography variant="body2" color="text.secondary">
          {castTexts.supplementHint}
        </Typography>
      ) : null}
      {view.problems.length ? (
        <Alert severity="warning">
          <LinkedText text={view.problems.join(' ')} />
        </Alert>
      ) : null}
      {!view.manifest ? (
        <Alert severity="info">
          <LinkedText text={castTexts.sourcesMissing} />
        </Alert>
      ) : null}
      {!cast ? (
        <CastEmptyState hasReadProblem={view.problems.length > 0} />
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
              hasSharedDescription={view.manifest?.references.some((reference) => reference.id === entity.id) ?? false}
              expanded={expanded === entity.id}
              onExpandedChange={(open) => setExpanded(open ? entity.id : null)}
              onUpdate={(patch) => update(entity.id, patch)}
              onRename={(nextId) => {
                // Проверка выполняется до смены кода, чтобы не создать дубликат ключа карточки.
                if (cast.entities.some((other) => other !== entity && other.id === nextId)) {
                  notify(castTexts.entityCodeTaken, 'warning');
                  return;
                }
                update(entity.id, { id: nextId });
                setExpanded(nextId);
              }}
              onGenerate={() => setGenerationTarget({ project, entity: { ...entity } })}
              generationDisabledReason={busy ? commonTexts.operationPending : dirty ? castTexts.imageGenerationSaveFirst : null}
              onRemove={() => remove(entity.id)}
            />
          ))}
        </Box>
      )}
      {cast && (
        <Box>
          <ActionButton variant="outlined" color="success" startIcon={<AddIcon />} disabled={busy} disabledReason={commonTexts.operationPending} onClick={add}>
            {castTexts.addEntity}
          </ActionButton>
        </Box>
      )}
      {cast && view.cast ? (
        <CastPropertiesEditor
          kinds={kinds}
          entities={cast.entities}
          properties={cast.properties}
          savedProperties={view.cast.properties}
          problem={propertiesProblem}
          onChange={(properties) => setCast((c) => c && { ...c, properties })}
        />
      ) : null}
      {generationTarget?.project === project && (
        <ImageGenerateDialog
          key={`${project}:${generationTarget.entity.id}`}
          mode="reference"
          project={project}
          target={generationTarget.entity.name || generationTarget.entity.id}
          initialPrompt={referenceImagePrompt({ name: generationTarget.entity.name })}
          // Описание общее с исходниками; сюжетная роль остаётся отдельным полем кастинга.
          referenceDescription={generationTarget.entity.appearance}
          referenceInput={{
            // Кастинг запускается после сохранения; привязки соседних сущностей не добавляются.
            images: generationTarget.entity.images.map((path) => {
              // Метаданные ищем по пути: выбранное подмножество и порядок кастинга остаются прежними.
              const file = view?.manifest?.references.flatMap((reference) => reference.files).find((file) => file.path === path);
              return referenceImageOption({ path: joinPath(project, 'source', path), view: file?.view, note: file?.note });
            })
          }}
          acceptedHint={castTexts.acceptedImageHint}
          onClose={() => setGenerationTarget(null)}
          onAccepted={async (result) => {
            if (!projectCurrent()) throw new Error(sourcesTexts.referenceTargetChanged);
            // При ошибке окно остаётся открытым: повторяется привязка принятого оригинала, а не генерация.
            await window.api.referenceImages.attach(result.id, generationTarget.entity.id);
            if (!projectCurrent()) return;
            await load();
            await refresh();
            await window.api.referenceImages.close(result.id);
            notify(castTexts.imageAttached, 'success');
          }}
        />
      )}
      <Typography variant="caption" color="text.secondary">
        {castTexts.entityCodeHint}
      </Typography>
    </Stack>
  );
}
