import { scenarioTexts } from '@shared/texts/scenario';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CastProperty, ScenarioSaveImpact, ScenarioView, ScenesFile, ScenesSaveMode, TreatmentSequence } from '@shared/types';
import { DEFAULT_FPS, FRAME_RATES } from '@shared/video';
import type { ScenarioPass } from '@shared/scenario-workflow';
import { useApp } from '../../state';
import { KEEP_NOTHING_REASON, type ScenarioBrief, type ScenesSaveRequest, type ShotReveal, type OpenShotState } from './types';
import { scenesSavedView } from './workflowDrafts';
import { requestedShot } from './shotNavigation';
import { partsFromSections, patchTreatmentPart } from './treatmentParts';
import { recalculateSceneBounds } from './sceneBounds';
import { SHOT_PARAM } from '../../components/shotRoutes';
import { useDraftBackup } from '../../hooks/useDraftBackup';

/** Загружает сценарий — логлайн, части и планы одним черновиком; проверка следует текущему черновику. */
export function useScenario() {
  const { state, status, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const activeProject = useRef(project);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ScenarioView | null>(null);
  const [scenes, setScenes] = useState<ScenesFile | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Проблемы текущего черновика: части (стык, длительность, коды) и, если они есть, планы. Сценарий из одних
  // частей сохраняется и с проблемами частей, сценарий с планами — только без проблем.
  const [problems, setProblems] = useState<string[]>([]);
  const [brief, setBrief] = useState<ScenarioBrief>(null);
  const [busy, setBusy] = useState(false);
  // Последний расчёт затронутых планов для текущего черновика: по нему заранее блокируется «Сохранить без производства».
  const [impact, setImpact] = useState<ScenarioSaveImpact | null>(null);
  const [saveRequest, setSaveRequest] = useState<ScenesSaveRequest | null>(null);
  const boundsRunning = useRef(false);
  const [params] = useSearchParams();
  const shotParam = params.get(SHOT_PARAM);
  // План, к которому после перехода с другой страницы или по источнику значения врезки нужно прокрутить реестр; сбрасывается после прокрутки.
  const [revealShot, setRevealShot] = useState<ShotReveal | null>(null);
  const clearReveal = useCallback(() => setRevealShot(null), []);

  useEffect(() => {
    activeProject.current = project;
  }, [project]);

  const load = useCallback(async () => {
    setLoadError(null);
    const next = await window.api.scenario.view(project);
    if (activeProject.current !== project) return;
    setView(next);
    setScenes(next.scenes ? JSON.parse(JSON.stringify(next.scenes)) : null);
    setSelected((current) => current ?? next.scenes?.scenes[0]?.id ?? null);
  }, [project]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  const scenesDirty = JSON.stringify(scenes) !== JSON.stringify(view?.scenes ?? null);

  // Несохранённые правки сценария (и расстановка точки съёмки в нём) страхуются временным файлом вне клипа.
  const draftBackup = useDraftBackup<ScenesFile | null>({
    project,
    kind: 'scenes',
    ready: view !== null,
    saved: view?.scenes ?? null,
    draft: scenes,
    dirty: scenesDirty,
    onRestore: (document) => {
      setScenes(document);
      setSelected((current) => (document?.scenes.some((shot) => shot.id === current) ? current : (document?.scenes[0]?.id ?? null)));
    },
    onError: (message) => notify(message, 'warning')
  });

  // Переход с ?shot= (с «Производства», «Сцен» или по ссылке на открытой странице) только выбирает план в черновике:
  // реестр не перечитывается, поэтому правки других планов остаются. Отсутствующий план оставляет обычный выбор.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const scenesReady = scenes !== null;
  useEffect(() => {
    const shot = requestedShot(scenesRef.current, shotParam);
    if (!shot) return;
    setSelected(shot);
    setRevealShot({ shot, target: 'shot' });
  }, [shotParam, scenesReady]);

  // Переход из отчёта проверки сценария: выбрать план в черновике и прокрутить к его постановке.
  const openShot = useCallback((shot: string) => {
    if (!requestedShot(scenesRef.current, shot)) return;
    setSelected(shot);
    setRevealShot({ shot, target: 'shot' });
  }, []);

  // Источник значения врезки: выбрать план в черновике (правки других планов остаются) и прокрутить к его блоку состояния.
  const openShotState = useCallback<OpenShotState>((shot, entity, phase) => {
    if (!requestedShot(scenesRef.current, shot)) return;
    setSelected(shot);
    setRevealShot({ shot, target: 'state', entity, phase });
  }, []);

  // Проверка, врезка и затронутые планы пересчитываются по текущему черновику сценария, не по файлу.
  useEffect(() => {
    if (!scenes) {
      setProblems([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      window.api.scenario
        .validateScenes(project, scenes)
        .then((next) => {
          if (!cancelled) setProblems(next);
        })
        .catch((error: unknown) => {
          if (!cancelled) setProblems([describeError(error)]);
        });
      // Без правок сохранять нечего; ошибка расчёта не блокирует кнопку: перед диалогом расчёт повторяется.
      if (scenesDirty)
        window.api.scenario
          .saveImpact(project, scenes)
          .then((value) => {
            if (!cancelled) setImpact(value);
          })
          .catch(() => {
            if (!cancelled) setImpact(null);
          });
      if (selected && scenes.scenes.some((s) => s.id === selected)) {
        Promise.all([window.api.scenario.brief(project, scenes, selected, 'before'), window.api.scenario.brief(project, scenes, selected, 'after')])
          .then(([before, after]) => {
            if (!cancelled) setBrief({ before, after });
          })
          .catch(() => {
            if (!cancelled) setBrief(null);
          });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [scenes, selected, project, scenesDirty, describeError]);

  const cast = view?.cast ?? null;
  const entityOptions = useMemo(() => (cast?.entities ?? []).map((e) => ({ id: e.id, label: e.name, images: e.images.length > 0, kind: e.kind })), [cast]);
  const referenceOptions = entityOptions.filter((e) => e.images);
  const propertiesOf = (entityId: string): CastProperty[] => {
    const entity = cast?.entities.find((e) => e.id === entityId);
    return entity ? (cast?.properties[entity.kind] ?? []) : [];
  };
  const duration = view?.duration ?? 0;
  // Есть ли у сценария планы: без них проблемы частей не мешают сохранению черновика.
  const hasShots = !!scenes?.scenes.length;
  // Каркас планов нужен агенту для подробного сценария: без разметки и кастинга с изображениями его не создать.
  const scenesInputProblem = !view?.timing?.lines?.length
    ? scenarioTexts.prerequisites.timing
    : !cast
      ? scenarioTexts.prerequisites.cast
      : !referenceOptions.length
        ? scenarioTexts.prerequisites.reference
        : null;
  // Те же обязательные данные нужны scene_scaffold для «Пересчитать границы»: части читаются из сохранённого сценария.
  const boundsProblem = !view?.timing?.lines?.length
    ? scenarioTexts.prerequisites.timing
    : !(Number(view.timing.duration_decoded || view.timing.duration_container) > 0)
      ? scenarioTexts.prerequisites.duration
      : !cast
        ? scenarioTexts.prerequisites.cast
        : !referenceOptions.length
          ? scenarioTexts.prerequisites.reference
          : !view.scenes?.sequences.length
            ? scenarioTexts.prerequisites.treatment
            : scenesDirty
              ? scenarioTexts.prerequisites.savedDrafts
              : null;

  // После публикации прохода черновик заменяется записанным сценарием: перед запуском правки сохранены или отменены.
  const acceptWorkflowUpdate = async (_pass: ScenarioPass): Promise<void> => {
    const next = await window.api.scenario.view(project);
    if (activeProject.current !== project) return;
    setView(next);
    setScenes(structuredClone(next.scenes));
    setSelected((current) => (next.scenes?.scenes.some((shot) => shot.id === current) ? current : (next.scenes?.scenes[0]?.id ?? null)));
    await refresh();
  };

  // Диалог согласует черновик до чтения агентного контекста; ошибка сохранения отменяет запуск.
  const resolveWorkflowDrafts = async (action: 'save' | 'discard'): Promise<boolean> => {
    if (action === 'discard') {
      setScenes(structuredClone(view?.scenes ?? null));
      return true;
    }
    setBusy(true);
    try {
      if (scenesDirty && scenes) {
        // Перед запуском агента сценарий сохраняется обычным образом: изменённая постановка требует нового производства.
        const saved = await window.api.scenario.saveScenes(project, scenes, 'production');
        if (activeProject.current !== project) return false;
        setScenes(saved);
        setView((current) => scenesSavedView(current, saved));
      }
      await refresh();
      return activeProject.current === project;
    } catch (error) {
      notify(describeError(error), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Пустой сценарий для ручного заполнения: только части, планы появятся вторым проходом агента.
  const emptyScenario = (): ScenesFile => ({
    schema_version: 1,
    fps: FRAME_RATES.find((rate) => rate === status?.fps) ?? DEFAULT_FPS,
    logline: '',
    sequences: [],
    scenes: []
  });
  const createScenario = (): void => setScenes(emptyScenario());
  // Части строятся встык по музыкальной карте; логлайн, общие правила и планы сценария остаются. Без сценария
  // создаётся новый черновик из одних частей.
  const partsFromTiming = (): void => {
    if (!view?.timing) return;
    setScenes({ ...(scenes ?? emptyScenario()), sequences: partsFromSections(view.timing.sections, view.duration) });
  };
  const updatePart = (index: number, patch: Partial<TreatmentSequence>): void =>
    setScenes((current) => current && { ...current, sequences: patchTreatmentPart(current.sequences, index, patch) });

  // Каркас строится по сохранённым частям без записи, а в черновик переносятся только окна планов: сохраняет
  // пользователь обычным «Сохранить» со списком затронутых планов.
  const recalculateBounds = async (): Promise<void> => {
    if (boundsRunning.current || boundsProblem || !scenes) return;
    boundsRunning.current = true;
    setBusy(true);
    try {
      // Состояние до пересчёта сохраняется точкой Git проекта (если он репозиторий); сбой Git не мешает пересчёту.
      await window.api.projectHistory.checkpoint(project, 'recalculateBounds');
      const result = await window.api.tools.run(project, 'scene_scaffold', ['--json']);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n').slice(-2).join(' '));
      const outcome = recalculateSceneBounds(scenes, JSON.parse(result.stdout) as ScenesFile, {
        treatment: view?.scenes ? { schema_version: 1, logline: view.scenes.logline, sequences: view.scenes.sequences } : null,
        lines: view?.timing?.lines ?? [],
        lyrics: view?.lyrics ?? [],
        duration: view?.duration ?? null
      });
      if ('problem' in outcome) notify(outcome.problem, 'warning');
      else if (outcome.scenes === scenes) notify(scenarioTexts.notice.boundsUnchanged, 'info');
      else {
        setScenes(outcome.scenes);
        if (outcome.changed.length) setSelected(outcome.changed[0]);
        notify(scenarioTexts.notice.boundsRecalculated({ count: outcome.changed.length }), 'success');
      }
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      boundsRunning.current = false;
      setBusy(false);
    }
  };

  // Записывает именно тот черновик, по которому показан список затронутых планов. keep — принятые планы, которые
  // остаются принятыми при обычном сохранении (выбор «Оставить принятым» в окне подтверждения).
  const writeScenes = async (draft: ScenesFile, mode: ScenesSaveMode, keep: string[] = []): Promise<void> => {
    const saved =
      mode === 'production' && keep.length
        ? await window.api.scenario.saveScenesKeeping(project, draft, keep)
        : await window.api.scenario.saveScenes(project, draft, mode);
    // Проблемы записанного сценария нужны сразу: фоновая проверка черновика могла ещё не закончиться.
    const found = saved.scenes.length ? [] : await window.api.scenario.validateScenes(project, saved).catch((error: unknown) => [describeError(error)]);
    if (activeProject.current !== project) return;
    setScenes(saved);
    setView((current) => scenesSavedView(current, saved));
    setImpact(null);
    await refresh();
    // Черновик частей с проблемами записан: это не ошибка, список остаётся над частями.
    if (found.length) notify(scenarioTexts.notice.treatmentSavedDraft, 'info');
    else notify(mode === 'keep' ? scenarioTexts.notice.scenesSavedKeep : scenarioTexts.notice.scenesSaved, 'success');
  };

  // Перед записью расчёт затронутых планов повторяется: черновик мог измениться после фонового расчёта.
  const saveScenes = async (mode: ScenesSaveMode): Promise<void> => {
    if (!scenes) return;
    const draft = scenes;
    setBusy(true);
    try {
      const value = await window.api.scenario.saveImpact(project, draft);
      if (activeProject.current !== project) return;
      setImpact(value);
      const produced = value.shots.some((shot) => shot.produced);
      if (!produced && mode === 'production') await writeScenes(draft, mode);
      else if (!produced) notify(KEEP_NOTHING_REASON, 'info');
      else setSaveRequest({ mode, scenes: draft, shots: value.shots });
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const confirmSaveScenes = async (keep: string[] = []): Promise<void> => {
    if (!saveRequest) return;
    setBusy(true);
    try {
      await writeScenes(saveRequest.scenes, saveRequest.mode, keep);
      setSaveRequest(null);
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const cancelSaveScenes = (): void => setSaveRequest(null);
  // Последний известный расчёт; без него кнопка доступна, а нажатие пересчитывает затронутые планы.
  const keepUseless = !!impact && !impact.shots.some((shot) => shot.produced);

  const retry = (): void => {
    load().catch((error) => setLoadError(describeError(error)));
  };
  return {
    project,
    view,
    loadError,
    retry,
    scenes,
    setScenes,
    selected,
    setSelected,
    revealShot,
    clearReveal,
    openShotState,
    openShot,
    problems,
    hasShots,
    brief,
    busy,
    cast,
    entityOptions,
    referenceOptions,
    propertiesOf,
    duration,
    scenesDirty,
    draftBackup,
    acceptWorkflowUpdate,
    resolveWorkflowDrafts,
    createScenario,
    partsFromTiming,
    updatePart,
    saveScenes,
    saveRequest,
    confirmSaveScenes,
    cancelSaveScenes,
    keepUseless,
    recalculateBounds,
    boundsProblem,
    scenesInputProblem,
    notify
  };
}
