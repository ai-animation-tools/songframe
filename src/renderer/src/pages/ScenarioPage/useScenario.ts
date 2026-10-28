import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CastProperty, ScenarioView, ScenesFile, TreatmentFile, TreatmentSequence } from '@shared/types';
import type { ScenarioPass } from '@shared/scenario-workflow';
import { useApp } from '../../state';
import type { ScenarioBrief, ScenarioTab } from './types';
import { workflowUpdatedView } from './workflowDrafts';

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
  const scaffoldRunning = useRef(false);

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

  // Проверка и врезка пересчитываются по текущему черновику реестра, не по файлу.
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
  }, [scenes, selected, project]);

  const cast = view?.cast ?? null;
  const entityOptions = useMemo(() => (cast?.entities ?? []).map((e) => ({ id: e.id, label: e.name, images: e.images.length > 0, kind: e.kind })), [cast]);
  const referenceOptions = entityOptions.filter((e) => e.images);
  const propertiesOf = (entityId: string): CastProperty[] => {
    const entity = cast?.entities.find((e) => e.id === entityId);
    return entity ? (cast?.properties[entity.kind] ?? []) : [];
  };
  const duration = view?.duration ?? 0;
  const scenesDirty = JSON.stringify(scenes) !== JSON.stringify(view?.scenes ?? null);
  const treatmentDirty = JSON.stringify(treatment) !== JSON.stringify(view?.treatment ?? null);
  // Каркас нужен и агенту для подробного сценария: без разметки и кастинга с изображениями его не создать.
  const scenesInputProblem = !view?.timing?.lines?.length
    ? 'На странице «Тайминги» разметьте строки песни и сохраните результат.'
    : !cast
      ? 'На странице «Кастинг» создайте героев и другие объекты клипа.'
      : !referenceOptions.length
        ? 'На странице «Кастинг» добавьте изображение хотя бы одному герою или объекту.'
        : null;
  // Те же обязательные данные нужны scene_scaffold; объяснение используем и в кнопке, и при запуске.
  const scaffoldProblem = !view?.timing?.lines?.length
    ? 'На странице «Тайминги» разметьте строки песни и сохраните результат.'
    : !(Number(view.timing.duration_decoded || view.timing.duration_container) > 0)
      ? 'На странице «Тайминги» заново разметьте трек, чтобы определить его длительность.'
      : !cast
        ? 'На странице «Кастинг» создайте героев и другие объекты клипа.'
        : !referenceOptions.length
          ? 'На странице «Кастинг» добавьте изображение хотя бы одному герою или объекту.'
          : !view.treatment
            ? 'Заполните и сохраните трактовку перед построением каркаса.'
            : treatmentDirty || scenesDirty
              ? 'Сохраните изменения трактовки и реестра сцен перед построением каркаса.'
              : !state?.toolsRoot
                ? 'Выберите папку комплекса в настройках, чтобы построить каркас.'
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
        const saved = await window.api.scenario.saveScenes(project, scenes);
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
      const base = name.toLowerCase().includes('припев')
        ? 'chorus'
        : name.toLowerCase().includes('куплет')
          ? 'verse'
          : name.toLowerCase().includes('вступ')
            ? 'intro'
            : name.toLowerCase().includes('финал')
              ? 'final'
              : name.toLowerCase().includes('проигрыш')
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
      notify('Трактовка сохранена', 'success');
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
      notify('Каркас реестра сцен построен', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      scaffoldRunning.current = false;
      setBusy(false);
    }
  };

  const saveScenes = async (): Promise<void> => {
    if (!scenes) return;
    setBusy(true);
    try {
      const saved = await window.api.scenario.saveScenes(project, scenes);
      setScenes(saved);
      setView((current) => current && { ...current, scenes: saved });
      await refresh();
      notify('Реестр сцен сохранён', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    notify('Скопировано', 'success');
  };

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
    scaffold,
    copy,
    scaffoldProblem,
    scenesInputProblem,
    notify
  };
}
