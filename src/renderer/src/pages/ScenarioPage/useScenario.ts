import { scenarioTexts } from '@shared/texts/scenario';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CastProperty, ScenarioSaveImpact, ScenarioView, ScenesFile, ScenesSaveMode, TreatmentFile, TreatmentSequence } from '@shared/types';
import type { ScenarioPass } from '@shared/scenario-workflow';
import { useApp } from '../../state';
import { KEEP_NOTHING_REASON, type ScenarioBrief, type ScenarioTab, type ScenesSaveRequest, type ShotReveal, type OpenShotState } from './types';
import { workflowUpdatedView } from './workflowDrafts';
import { requestedShot } from './shotNavigation';
import { SHOT_PARAM } from '../../components/shotRoutes';

/** Загружает сценарий и сохраняет вкладки независимо; проверка следует текущему черновику. */
export function useScenario() {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const activeProject = useRef(project);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ScenarioView | null>(null);
  const [tab, setTab] = useState<ScenarioTab>('scenes');
  const [treatment, setTreatment] = useState<TreatmentFile | null>(null);
  const [scenes, setScenes] = useState<ScenesFile | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [brief, setBrief] = useState<ScenarioBrief>(null);
  const [busy, setBusy] = useState(false);
  // Последний расчёт затронутых планов для текущего черновика: по нему заранее блокируется «Сохранить без производства».
  const [impact, setImpact] = useState<ScenarioSaveImpact | null>(null);
  const [saveRequest, setSaveRequest] = useState<ScenesSaveRequest | null>(null);
  const scaffoldRunning = useRef(false);
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
    setTreatment(next.treatment ? JSON.parse(JSON.stringify(next.treatment)) : null);
    setScenes(next.scenes ? JSON.parse(JSON.stringify(next.scenes)) : null);
    setTab(next.scenes ? 'scenes' : 'treatment');
    setSelected((current) => current ?? next.scenes?.scenes[0]?.id ?? null);
  }, [project]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  const scenesDirty = JSON.stringify(scenes) !== JSON.stringify(view?.scenes ?? null);

  // Переход с ?shot= (с «Производства», «Сцен» или по ссылке на открытой странице) только выбирает план в черновике:
  // реестр не перечитывается, поэтому правки других планов остаются. Отсутствующий план оставляет обычный выбор.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const scenesReady = scenes !== null;
  useEffect(() => {
    const shot = requestedShot(scenesRef.current, shotParam);
    if (!shot) return;
    setTab('scenes');
    setSelected(shot);
    setRevealShot({ shot, target: 'shot' });
  }, [shotParam, scenesReady]);

  // Источник значения врезки: выбрать план в черновике (правки других планов остаются) и прокрутить к его блоку состояния.
  const openShotState = useCallback<OpenShotState>((shot, entity, phase) => {
    if (!requestedShot(scenesRef.current, shot)) return;
    setTab('scenes');
    setSelected(shot);
    setRevealShot({ shot, target: 'state', entity, phase });
  }, []);

  // Проверка, врезка и затронутые планы пересчитываются по текущему черновику реестра, не по файлу.
  useEffect(() => {
    if (!scenes) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      window.api.scenario
        .validateScenes(project, scenes)
        .then((next) => {
          if (!cancelled) setProblems(next);
        })
        .catch(() => undefined);
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
  }, [scenes, selected, project, scenesDirty]);

  const cast = view?.cast ?? null;
  const entityOptions = useMemo(() => (cast?.entities ?? []).map((e) => ({ id: e.id, label: e.name, images: e.images.length > 0, kind: e.kind })), [cast]);
  const referenceOptions = entityOptions.filter((e) => e.images);
  const propertiesOf = (entityId: string): CastProperty[] => {
    const entity = cast?.entities.find((e) => e.id === entityId);
    return entity ? (cast?.properties[entity.kind] ?? []) : [];
  };
  const duration = view?.duration ?? 0;
  const treatmentDirty = JSON.stringify(treatment) !== JSON.stringify(view?.treatment ?? null);
  // Каркас нужен и агенту для подробного сценария: без разметки и кастинга с изображениями его не создать.
  const scenesInputProblem = !view?.timing?.lines?.length
    ? scenarioTexts.prerequisites.timing
    : !cast
      ? scenarioTexts.prerequisites.cast
      : !referenceOptions.length
        ? scenarioTexts.prerequisites.reference
        : null;
  // Те же обязательные данные нужны scene_scaffold; объяснение используем и в кнопке, и при запуске.
  const scaffoldProblem = !view?.timing?.lines?.length
    ? scenarioTexts.prerequisites.timing
    : !(Number(view.timing.duration_decoded || view.timing.duration_container) > 0)
      ? scenarioTexts.prerequisites.duration
      : !cast
        ? scenarioTexts.prerequisites.cast
        : !referenceOptions.length
          ? scenarioTexts.prerequisites.reference
          : !view.treatment
            ? scenarioTexts.prerequisites.treatment
            : treatmentDirty || scenesDirty
              ? scenarioTexts.prerequisites.savedDrafts
              : !state?.toolsRoot
                ? scenarioTexts.prerequisites.tools
                : null;

  // После публикации меняем только принадлежащий проходу черновик: другая вкладка сохраняет свои правки.
  const acceptWorkflowUpdate = async (pass: ScenarioPass): Promise<void> => {
    const next = await window.api.scenario.view(project);
    if (activeProject.current !== project) return;
    setView((current) => workflowUpdatedView(current, next, pass));
    if (pass === 'treatment') setTreatment(structuredClone(next.treatment));
    else {
      setScenes(structuredClone(next.scenes));
      setSelected((current) => (next.scenes?.scenes.some((shot) => shot.id === current) ? current : (next.scenes?.scenes[0]?.id ?? null)));
    }
    await refresh();
  };

  // Диалог согласует оба черновика до чтения агентного контекста; ошибка сохранения отменяет запуск.
  const resolveWorkflowDrafts = async (action: 'save' | 'discard'): Promise<boolean> => {
    if (action === 'discard') {
      setTreatment(structuredClone(view?.treatment ?? null));
      setScenes(structuredClone(view?.scenes ?? null));
      return true;
    }
    setBusy(true);
    try {
      if (treatmentDirty && treatment) {
        const saved = await window.api.scenario.saveTreatment(project, treatment);
        if (activeProject.current !== project) return false;
        setTreatment(saved);
        setView((current) => current && { ...current, treatment: saved });
      }
      if (scenesDirty && scenes) {
        // Перед запуском агента реестр сохраняется обычным образом: изменённая постановка требует нового производства.
        const saved = await window.api.scenario.saveScenes(project, scenes, 'production');
        if (activeProject.current !== project) return false;
        setScenes(saved);
        setView((current) => current && { ...current, scenes: saved });
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

  // Действия трактовки сохраняют независимый черновик реестра.
  const partsFromTiming = (): void => {
    if (!view?.timing) return;
    const used = new Set<string>();
    const slug = (name: string, index: number): string => {
      // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
      const base = name.toLowerCase().includes('припев')
        ? 'chorus'
        : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
          name.toLowerCase().includes('куплет')
          ? 'verse'
          : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
            name.toLowerCase().includes('вступ')
            ? 'intro'
            : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
              name.toLowerCase().includes('финал')
              ? 'final'
              : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
                name.toLowerCase().includes('проигрыш')
                ? 'bridge'
                : `part${index + 1}`;
      let candidate = base;
      let n = 2;
      while (used.has(candidate)) candidate = `${base}_${n++}`;
      used.add(candidate);
      return candidate;
    };
    const sequences: TreatmentSequence[] = view.timing.sections.map((s, i) => ({
      id: slug(s.name, i),
      title: s.name,
      direction: '',
      start: s.start,
      end: s.end,
      entities: [],
      lipsync: !/без вокала|вступление|проигрыш/i.test(s.name + (s.note ?? '')),
      max_shot_seconds: 6
    }));
    setTreatment({ schema_version: 1, logline: treatment?.logline ?? '', sequences });
  };
  const updatePart = (index: number, patch: Partial<TreatmentSequence>): void =>
    setTreatment((t) => t && { ...t, sequences: t.sequences.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const saveTreatment = async (): Promise<void> => {
    if (!treatment) return;
    setBusy(true);
    try {
      const saved = await window.api.scenario.saveTreatment(project, treatment);
      // Сохранение трактовки не заменяет несохранённый черновик реестра другой вкладки.
      setTreatment(saved);
      setView((current) => current && { ...current, treatment: saved });
      await refresh();
      notify(scenarioTexts.notice.treatmentSaved, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const scaffold = async (force: boolean): Promise<void> => {
    if (scaffoldRunning.current || scaffoldProblem) return;
    scaffoldRunning.current = true;
    setBusy(true);
    try {
      const result = await window.api.tools.run(project, 'scene_scaffold', force ? ['--json', '--force'] : ['--json']);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n').slice(-2).join(' '));
      await load();
      await refresh();
      setTab('scenes');
      notify(scenarioTexts.notice.scaffoldCreated, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      scaffoldRunning.current = false;
      setBusy(false);
    }
  };

  // Записывает именно тот черновик, по которому показан список затронутых планов.
  const writeScenes = async (draft: ScenesFile, mode: ScenesSaveMode): Promise<void> => {
    const saved = await window.api.scenario.saveScenes(project, draft, mode);
    if (activeProject.current !== project) return;
    setScenes(saved);
    setView((current) => current && { ...current, scenes: saved });
    setImpact(null);
    await refresh();
    notify(mode === 'keep' ? scenarioTexts.notice.scenesSavedKeep : scenarioTexts.notice.scenesSaved, 'success');
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
  const confirmSaveScenes = async (): Promise<void> => {
    if (!saveRequest) return;
    setBusy(true);
    try {
      await writeScenes(saveRequest.scenes, saveRequest.mode);
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
    tab,
    setTab,
    treatment,
    setTreatment,
    scenes,
    setScenes,
    selected,
    setSelected,
    revealShot,
    clearReveal,
    openShotState,
    problems,
    brief,
    busy,
    cast,
    entityOptions,
    referenceOptions,
    propertiesOf,
    duration,
    scenesDirty,
    treatmentDirty,
    acceptWorkflowUpdate,
    resolveWorkflowDrafts,
    partsFromTiming,
    updatePart,
    saveTreatment,
    saveScenes,
    saveRequest,
    confirmSaveScenes,
    cancelSaveScenes,
    keepUseless,
    scaffold,
    scaffoldProblem,
    scenesInputProblem,
    notify
  };
}
