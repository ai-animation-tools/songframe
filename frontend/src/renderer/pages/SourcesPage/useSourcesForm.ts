import { referenceImageTexts } from '@shared/texts/reference-images';
import { sourcesTexts } from '@shared/texts/sources';
/** Загрузка, проверка и сохранение общей формы исходников. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SOURCE_KINDS, type ReferenceKind, type ReferenceView, type SourceKind, type SourcesInput, type SourcesView } from '@shared/types';
import { referenceImagePrompt } from '@shared/reference-image-generation';
import type { ImageGenerationResult } from '../../hooks/useImageGeneration';
import { analyzeLyrics } from '@shared/lyrics';
import { joinPath } from '../../format';
import { useApp } from '../../state';
import { RequestScope } from '../../hooks/requestScope';
import { referenceImageOption } from '../../hooks/referenceImageOptions';
import { AUDIO_FILTER, IMAGE_FILTER, TEXT_FILTER, kindForId, nextKey, stripKeys } from './helpers';
import type { FileForm, KindForm, ReferenceForm } from './types';

export function useSourcesForm() {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [view, setView] = useState<SourcesView | null>(null);
  const [trackNew, setTrackNew] = useState<string | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [idea, setIdea] = useState('');
  const [coverNew, setCoverNew] = useState<string | null>(null);
  const [coverRemove, setCoverRemove] = useState(false);
  const [coverGenerationOpen, setCoverGenerationOpen] = useState(false);
  const [generatedCover, setGeneratedCover] = useState<{ id: string; path: string } | null>(null);
  const [referenceTarget, setReferenceTarget] = useState<{ project: string; key: number } | null>(null);
  const generatedRefs = useRef(new Set<string>());
  const projectScope = useRef(new RequestScope());
  projectScope.current.update(project);
  const projectCurrent = projectScope.current.capture(project);
  const [refs, setRefs] = useState<ReferenceForm[]>([]);
  const latestRefs = useRef(refs);
  latestRefs.current = refs;
  const removing = useRef(new Set<number>());
  const [removalPending, setRemovalPending] = useState<number[]>([]);
  const [removalProblems, setRemovalProblems] = useState<Record<number, string>>({});
  const [kinds, setKinds] = useState<SourceKind[]>(DEFAULT_SOURCE_KINDS);
  const [kindDialog, setKindDialog] = useState<KindForm | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedRefs, setSavedRefs] = useState('[]');

  // Принятый обрезанный файл нужен до сохранения формы; замена и уход со страницы удаляют временную сессию.
  useEffect(
    () => () => {
      if (generatedCover) void window.api.cover.close(generatedCover.id).catch(() => undefined);
    },
    [generatedCover]
  );

  const closeGeneratedRefs = useCallback(() => {
    const sessions = [...generatedRefs.current];
    generatedRefs.current.clear();
    for (const id of sessions) void window.api.referenceImages.close(id).catch(() => undefined);
  }, []);
  useEffect(() => () => closeGeneratedRefs(), [project, closeGeneratedRefs]);

  const load = useCallback(async () => {
    const current = projectScope.current.capture(project);
    try {
      setLoadError(null);
      setView(null);
      const next = await window.api.sources.view(project);
      // Ошибка промпта остаётся у его владельца: остальные исходники доступны в форме.
      const loadedRefs = await Promise.all(
        (next.manifest?.references ?? []).map(async (r): Promise<ReferenceForm> => {
          let prompt = '';
          let promptError: ReferenceForm['promptError'];
          if (r.prompt) {
            try {
              prompt = await window.api.shell.readText(joinPath(project, 'source', r.prompt));
            } catch (error) {
              promptError = { path: r.prompt, message: describeError(error) };
            }
          }
          return {
            key: nextKey(),
            id: r.id,
            kind: r.kind,
            savedKind: r.kind,
            name: r.name,
            short_name: r.short_name,
            description: r.description,
            prompt,
            promptError,
            files: await Promise.all(
              r.files.map(async (f): Promise<FileForm> => {
                let filePrompt = '';
                let filePromptError: FileForm['promptError'];
                if (f.prompt) {
                  try {
                    filePrompt = await window.api.shell.readText(joinPath(project, 'source', f.prompt));
                  } catch (error) {
                    filePromptError = { path: f.prompt, message: describeError(error) };
                  }
                }
                // Старый общий промпт не назначается изображениям: у каждого хранится собственный текст.
                return { key: nextKey(), existingPath: f.path, view: f.view, note: f.note, prompt: filePrompt, promptError: filePromptError };
              })
            )
          };
        })
      );
      // Поздний ответ прежнего проекта не должен подменять новую форму и назначение генерации.
      if (!current()) return;
      setReferenceTarget(null);
      setSavedRefs(JSON.stringify(loadedRefs.map(stripKeys)));
      setView(next);
      setKinds(next.manifest?.kinds?.length ? next.manifest.kinds : DEFAULT_SOURCE_KINDS.map((k) => ({ ...k })));
      setLyrics(next.lyricsText);
      setIdea(next.ideaText);
      setTrackNew(null);
      setCoverNew(null);
      setGeneratedCover(null);
      setCoverGenerationOpen(false);
      setCoverRemove(false);
      setRefs(loadedRefs);
      setRemovalProblems({});
      setRemovalPending([]);
    } catch (failure) {
      // Ошибка прежнего проекта не должна скрывать уже открытый новый проект.
      if (current()) throw failure;
    }
  }, [project, describeError]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  const lyricsCheck = useMemo(() => analyzeLyrics(lyrics), [lyrics]);

  const input = useMemo<SourcesInput>(
    () => ({
      kinds,
      track: trackNew ? { path: trackNew } : null,
      lyrics: lyrics !== (view?.lyricsText ?? '') || (!view?.manifest?.lyrics && lyrics.trim()) ? { text: lyrics } : null,
      idea: idea !== (view?.ideaText ?? '') || (!view?.manifest?.idea && idea.trim()) ? { text: idea } : null,
      cover: coverNew ? { path: coverNew } : coverRemove ? { remove: true } : null,
      references: refs.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        short_name: r.short_name,
        description: r.description,
        prompt: r.prompt,
        files: r.files.map((f) => ({ sourcePath: f.sourcePath, existingPath: f.existingPath, view: f.view, note: f.note, prompt: f.prompt }))
      }))
    }),
    [kinds, trackNew, lyrics, idea, coverNew, coverRemove, refs, view]
  );

  useEffect(() => {
    if (!view) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      window.api.sources
        .validate(project, input)
        .then((next) => {
          if (!cancelled) setProblems(next);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [input, project, view]);

  const selectTrack = (paths: string[]): void => {
    const [path] = paths;
    if (!path) return;
    // Выбор уже сохранённого трека не должен ставить его в очередь копирования поверх себя.
    const savedPath = view?.manifest?.track ? joinPath(project, 'source', view.manifest.track.path) : null;
    setTrackNew(path === savedPath ? null : path);
  };
  const pickTrack = async (): Promise<void> => {
    selectTrack(await window.api.dialog.pickFiles({ title: sourcesTexts.pickTrackTitle, filters: AUDIO_FILTER }));
  };
  // Оба способа импорта используют одно чтение и одинаковую проверку текста песни.
  const importText = async (setter: (text: string) => void, path: string): Promise<void> => {
    try {
      const text = await window.api.shell.readText(path);
      setter(text);
      if (setter === setLyrics && analyzeLyrics(text).problems.length) notify(sourcesTexts.lyricsImportedWarning, 'warning');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  const pickText = async (setter: (text: string) => void, title: string): Promise<void> => {
    const [path] = await window.api.dialog.pickFiles({ title, filters: TEXT_FILTER });
    if (path) await importText(setter, path);
  };
  const selectCover = (paths: string[]): void => {
    const [path] = paths;
    if (path) {
      if (generatedCover?.path !== path) setGeneratedCover(null);
      // Уже сохранённая обложка не должна копироваться поверх самой себя при сохранении.
      setCoverNew(path === view?.coverPath ? null : path);
      setCoverRemove(false);
    }
  };
  const pickCover = async (): Promise<void> => {
    selectCover(await window.api.dialog.pickFiles({ title: sourcesTexts.pickCoverTitle, filters: IMAGE_FILTER }));
  };

  // Новый референс с кодом сущности кастинга берёт её тип: изображения сразу лягут в папку этого типа.
  const updateRef = (key: number, patch: Partial<ReferenceForm>): void =>
    setRefs((current) =>
      current.map((r) => {
        if (r.key !== key) return r;
        const kind = patch.id !== undefined && patch.kind === undefined ? kindForId(r, patch.id, view?.entityKinds ?? {}, kinds) : (patch.kind ?? r.kind);
        return { ...r, ...patch, kind, promptError: 'prompt' in patch ? undefined : r.promptError };
      })
    );
  const retryFilePrompt = async (refKey: number, fileKey: number): Promise<void> => {
    const failed = refs.find((r) => r.key === refKey)?.files.find((f) => f.key === fileKey)?.promptError;
    if (!failed) return;
    try {
      const prompt = await window.api.shell.readText(joinPath(project, 'source', failed.path));
      // Повторное чтение меняет только тот промпт изображения, который всё ещё ожидает восстановления.
      setRefs((current) =>
        current.map((r) =>
          r.key === refKey
            ? { ...r, files: r.files.map((f) => (f.key === fileKey && f.promptError === failed ? { ...f, prompt, promptError: undefined } : f)) }
            : r
        )
      );
    } catch (error) {
      const message = describeError(error);
      setRefs((current) =>
        current.map((r) =>
          r.key === refKey
            ? { ...r, files: r.files.map((f) => (f.key === fileKey && f.promptError === failed ? { ...f, promptError: { ...failed, message } } : f)) }
            : r
        )
      );
    }
  };
  const addReference = (): void =>
    setRefs((current) => [
      ...current,
      { key: nextKey(), id: '', kind: kinds[0]?.id ?? 'character', name: '', short_name: '', description: '', prompt: '', files: [] }
    ]);
  const kindLabel = (id: ReferenceKind): string => kinds.find((k) => k.id === id)?.label ?? id;
  const removeKind = (id: string): void => {
    if (refs.some((r) => r.kind === id)) {
      notify(sourcesTexts.kindInUse({ label: kindLabel(id) }), 'warning');
      return;
    }
    setKinds((current) => current.filter((k) => k.id !== id));
  };
  const addKind = (): void => {
    if (!kindDialog) return;
    const id = kindDialog.id.trim();
    const dir = kindDialog.dir.trim() || id;
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !kindDialog.label.trim()) {
      notify(sourcesTexts.kindValidation, 'warning');
      return;
    }
    if (kinds.some((k) => k.id === id || k.dir === dir)) {
      notify(sourcesTexts.duplicateKind, 'warning');
      return;
    }
    setKinds((current) => [...current, { id, label: kindDialog.label.trim(), dir }]);
    setKindDialog(null);
  };
  const appendFiles = (key: number, paths: string[]): void => {
    if (!paths.length) return;
    setRefs((current) =>
      current.map((r) =>
        r.key === key
          ? {
              ...r,
              files: [
                ...r.files,
                ...[...new Set(paths)]
                  .filter((p) => !r.files.some((file) => (file.sourcePath ?? joinPath(project, 'source', file.existingPath!)) === p))
                  .map((p, index) => ({
                    key: nextKey(),
                    sourcePath: p,
                    view: (r.files.length || index ? 'other' : 'full') as ReferenceView,
                    note: '',
                    prompt: ''
                  }))
              ]
            }
          : r
      )
    );
  };
  const addFiles = async (key: number): Promise<void> => {
    appendFiles(key, await window.api.dialog.pickFiles({ title: sourcesTexts.pickReferenceImagesTitle, filters: IMAGE_FILTER, multiple: true }));
  };
  const updateFile = (refKey: number, fileKey: number, patch: Partial<FileForm>): void =>
    setRefs((current) =>
      current.map((r) =>
        r.key === refKey
          ? { ...r, files: r.files.map((f) => (f.key === fileKey ? { ...f, ...patch, promptError: 'prompt' in patch ? undefined : f.promptError } : f)) }
          : r
      )
    );
  // Проверка идёт до изменения формы: отказ не требует перезагрузки и не теряет соседние правки.
  const removeReferenceFiles = async (refKey: number, fileKey?: number): Promise<void> => {
    const reference = refs.find((item) => item.key === refKey);
    if (!reference || removing.current.has(refKey)) return;
    const files = fileKey === undefined ? reference.files : reference.files.filter((file) => file.key === fileKey);
    const paths = new Set(files.flatMap((file) => (file.existingPath ? [file.existingPath] : [])));
    const warn = (message: string): void => {
      setRemovalProblems((current) => ({ ...current, [refKey]: message }));
      notify(message, 'warning');
    };
    removing.current.add(refKey);
    setRemovalPending((current) => [...current, refKey]);
    try {
      if (paths.size) {
        const checked = await window.api.cast.view(project);
        if (!projectCurrent()) return;
        if (!checked.cast && checked.problems.length) throw new Error(checked.problems.join(' '));
        const users = checked.cast?.entities.filter((entity) => entity.images.some((path) => paths.has(path))) ?? [];
        if (users.length) {
          warn(
            `${referenceImageTexts.imageInUse} ${sourcesTexts.referenceRemovalUsedBy({ names: users.map((entity) => entity.name || entity.id).join(', ') })}`
          );
          return;
        }
      }
      if (!projectCurrent()) return;
      const current = latestRefs.current.find((item) => item.key === refKey);
      // Пока читался кастинг, пользователь мог изменить именно удаляемую строку или весь объект.
      if (!current || (fileKey === undefined ? current !== reference : current.files.find((file) => file.key === fileKey) !== files[0])) {
        warn(sourcesTexts.referenceRemovalChanged);
        return;
      }
      setRemovalProblems((problems) => {
        const next = { ...problems };
        delete next[refKey];
        return next;
      });
      setRefs((items) =>
        fileKey === undefined
          ? items.filter((item) => item.key !== refKey)
          : items.map((item) => (item.key === refKey ? { ...item, files: item.files.filter((file) => file.key !== fileKey) } : item))
      );
    } catch (error) {
      if (projectCurrent()) warn(`${sourcesTexts.referenceRemovalCheckFailed} ${describeError(error)}`);
    } finally {
      removing.current.delete(refKey);
      if (projectCurrent()) setRemovalPending((current) => current.filter((key) => key !== refKey));
    }
  };

  const hasPromptErrors = refs.some((r) => !!r.promptError || r.files.some((f) => !!f.promptError));

  const save = async (): Promise<void> => {
    // Непрочитанный промпт нельзя передавать как пустой: saveSources удаляет прежний файл и ссылку на него.
    if (hasPromptErrors) {
      notify(sourcesTexts.promptReadSaveBlocked, 'warning');
      return;
    }
    setBusy(true);
    try {
      await window.api.sources.save(project, input);
      if (!projectCurrent()) return;
      closeGeneratedRefs();
      await load().catch((error) => {
        if (!projectCurrent()) return;
        setView(null);
        setLoadError(describeError(error));
        throw error;
      });
      await refresh();
      notify(sourcesTexts.saved, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const manifest = view?.manifest;
  const fileUrl = (relativeOrAbsolute: string, absolute = false): string =>
    window.api.shell.fileUrl(absolute ? relativeOrAbsolute : joinPath(project, 'source', relativeOrAbsolute));
  const coverSrc = coverNew ? fileUrl(coverNew, true) : !coverRemove && view?.coverPath ? fileUrl(view?.coverPath, true) : null;
  const savedKinds = manifest?.kinds?.length ? manifest.kinds : DEFAULT_SOURCE_KINDS;
  const dirty =
    !!(input.track || input.lyrics || input.idea || input.cover) ||
    JSON.stringify(kinds) !== JSON.stringify(savedKinds) ||
    JSON.stringify(refs.map(stripKeys)) !== savedRefs;

  const generationReference = referenceTarget?.project === project ? refs.find((reference) => reference.key === referenceTarget.key) : null;

  return {
    view,
    loadError,
    busy,
    problems,
    lyricsCheck,
    dirty,
    hasPromptErrors,
    retry: () => load().catch((error) => setLoadError(describeError(error))),
    save,
    trackProps: { track: manifest?.track ?? null, trackNew, fileUrl, onPick: pickTrack, onDrop: selectTrack, onClear: () => setTrackNew(null) },
    coverProps: {
      coverSrc,
      onPick: pickCover,
      onDrop: selectCover,
      onGenerate: () => setCoverGenerationOpen(true),
      onRemove: () => {
        setCoverNew(null);
        setGeneratedCover(null);
        setCoverRemove(!!manifest?.cover);
      }
    },
    coverGenerationProps: {
      open: coverGenerationOpen,
      project,
      idea,
      referenceInput: {
        images: refs.flatMap((reference) =>
          reference.files.map((file) => {
            const option = referenceImageOption({ path: file.sourcePath ?? joinPath(project, 'source', file.existingPath!), view: file.view });
            return { ...option, label: `${reference.name || reference.id} · ${option.label}` };
          })
        )
      },
      onClose: () => setCoverGenerationOpen(false),
      onAccepted: (result: { id: string; path: string }) => {
        setCoverNew(result.path);
        setCoverRemove(false);
        setGeneratedCover(result);
        notify(sourcesTexts.coverSelected, 'info');
      }
    },
    referenceGenerationProps: generationReference
      ? {
          project,
          target: generationReference.name || generationReference.id,
          initialPrompt: referenceImagePrompt({ name: generationReference.name }),
          referenceDescription: generationReference.description,
          referenceContextDrafts: { idea, lyrics },
          // Берём текущий черновик и только изображения выбранного объекта, включая ещё не сохранённые загрузки.
          referenceInput: {
            images: generationReference.files.map((file) =>
              referenceImageOption({ path: file.sourcePath ?? joinPath(project, 'source', file.existingPath!), view: file.view, note: file.note })
            )
          },
          acceptedHint: sourcesTexts.acceptedReferenceHint,
          onClose: () => setReferenceTarget(null),
          onAccepted: (result: ImageGenerationResult) => {
            if (!projectCurrent()) throw new Error(sourcesTexts.referenceTargetChanged);
            generatedRefs.current.add(result.id);
            setRefs((current) =>
              current.map((reference) =>
                reference.key === generationReference.key
                  ? {
                      ...reference,
                      files: [
                        ...reference.files,
                        { key: nextKey(), sourcePath: result.path, view: reference.files.length ? 'other' : 'full', note: '', prompt: result.prompt ?? '' }
                      ]
                    }
                  : reference
              )
            );
            notify(sourcesTexts.referenceImageSelected, 'info');
          }
        }
      : null,
    lyricsProps: {
      lyrics,
      lyricsCheck,
      onChange: setLyrics,
      onPick: () => pickText(setLyrics, sourcesTexts.pickLyricsTitle),
      onDrop: (paths: string[]) => importText(setLyrics, paths[0])
    },
    ideaProps: {
      idea,
      onChange: setIdea,
      onPick: () => pickText(setIdea, sourcesTexts.pickIdeaTitle),
      onDrop: (paths: string[]) => importText(setIdea, paths[0])
    },
    referencesProps: {
      refs,
      kinds,
      pinnedReferences: view?.pinnedReferences ?? {},
      fileUrl,
      filePath: (path: string, absolute = false) => (absolute ? path : joinPath(project, 'source', path)),
      removalProblems,
      removalPending,
      onAdd: addReference,
      onUpdate: updateRef,
      onRetryFilePrompt: retryFilePrompt,
      onRemove: (key: number) => removeReferenceFiles(key),
      onGenerate: (key: number) => setReferenceTarget({ project, key }),
      onAddFiles: addFiles,
      onDropFiles: appendFiles,
      onUpdateFile: updateFile,
      onRemoveFile: removeReferenceFiles,
      onRemoveKind: removeKind,
      onAddKind: () => setKindDialog({ label: '', id: '', dir: '' })
    },
    kindDialogProps: { value: kindDialog, onChange: setKindDialog, onClose: () => setKindDialog(null), onAdd: addKind }
  };
}
