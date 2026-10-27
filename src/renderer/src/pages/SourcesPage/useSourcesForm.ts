/** Загрузка, проверка и сохранение общей формы исходников. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_SOURCE_KINDS, type ReferenceKind, type ReferenceView, type SourceKind, type SourcesInput, type SourcesView } from '@shared/types';
import { analyzeLyrics } from '@shared/lyrics';
import { joinPath } from '../../format';
import { useApp } from '../../state';
import { AUDIO_FILTER, IMAGE_FILTER, TEXT_FILTER, nextKey, stripKeys } from './helpers';
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
  const [refs, setRefs] = useState<ReferenceForm[]>([]);
  const [kinds, setKinds] = useState<SourceKind[]>(DEFAULT_SOURCE_KINDS);
  const [kindDialog, setKindDialog] = useState<KindForm | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedRefs, setSavedRefs] = useState('[]');

  const load = useCallback(async () => {
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
    setSavedRefs(JSON.stringify(loadedRefs.map(stripKeys)));
    setView(next);
    setKinds(next.manifest?.kinds?.length ? next.manifest.kinds : DEFAULT_SOURCE_KINDS.map((k) => ({ ...k })));
    setLyrics(next.lyricsText);
    setIdea(next.ideaText);
    setTrackNew(null);
    setCoverNew(null);
    setCoverRemove(false);
    setRefs(loadedRefs);
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
    selectTrack(await window.api.dialog.pickFiles({ title: 'Трек в MP3', filters: AUDIO_FILTER }));
  };
  // Оба способа импорта используют одно чтение и одинаковую проверку текста песни.
  const importText = async (setter: (text: string) => void, path: string): Promise<void> => {
    try {
      const text = await window.api.shell.readText(path);
      setter(text);
      if (setter === setLyrics && analyzeLyrics(text).problems.length)
        notify('Текст загружен в поле. Исправьте отмеченные ошибки формата перед сохранением.', 'warning');
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
      // Уже сохранённая обложка не должна копироваться поверх самой себя при сохранении.
      setCoverNew(path === view?.coverPath ? null : path);
      setCoverRemove(false);
    }
  };
  const pickCover = async (): Promise<void> => {
    selectCover(await window.api.dialog.pickFiles({ title: 'Обложка клипа', filters: IMAGE_FILTER }));
  };

  const updateRef = (key: number, patch: Partial<ReferenceForm>): void =>
    setRefs((current) => current.map((r) => (r.key === key ? { ...r, ...patch, promptError: 'prompt' in patch ? undefined : r.promptError } : r)));
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
      notify(`Тип «${kindLabel(id)}» используется референсами: сначала смените их тип.`, 'warning');
      return;
    }
    setKinds((current) => current.filter((k) => k.id !== id));
  };
  const addKind = (): void => {
    if (!kindDialog) return;
    const id = kindDialog.id.trim();
    const dir = kindDialog.dir.trim() || id;
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !kindDialog.label.trim()) {
      notify('Код типа: латиница в нижнем регистре, цифры, подчёркивание; подпись обязательна.', 'warning');
      return;
    }
    if (kinds.some((k) => k.id === id || k.dir === dir)) {
      notify('Такой код или папка уже есть.', 'warning');
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
    appendFiles(key, await window.api.dialog.pickFiles({ title: 'Изображения референса', filters: IMAGE_FILTER, multiple: true }));
  };
  const updateFile = (refKey: number, fileKey: number, patch: Partial<FileForm>): void =>
    setRefs((current) =>
      current.map((r) =>
        r.key === refKey
          ? { ...r, files: r.files.map((f) => (f.key === fileKey ? { ...f, ...patch, promptError: 'prompt' in patch ? undefined : f.promptError } : f)) }
          : r
      )
    );
  const removeFile = (refKey: number, fileKey: number): void =>
    setRefs((current) => current.map((r) => (r.key === refKey ? { ...r, files: r.files.filter((f) => f.key !== fileKey) } : r)));

  const hasPromptErrors = refs.some((r) => !!r.promptError || r.files.some((f) => !!f.promptError));

  const save = async (): Promise<void> => {
    // Непрочитанный промпт нельзя передавать как пустой: saveSources удаляет прежний файл и ссылку на него.
    if (hasPromptErrors) {
      notify(
        'Не удалось прочитать описания референсов. Восстановите файлы или замените текст промптов в соответствующих карточках перед сохранением.',
        'warning'
      );
      return;
    }
    setBusy(true);
    try {
      await window.api.sources.save(project, input);
      await load().catch((error) => {
        setView(null);
        setLoadError(describeError(error));
        throw error;
      });
      await refresh();
      notify('Исходники сохранены', 'success');
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
      onRemove: () => {
        setCoverNew(null);
        setCoverRemove(!!manifest?.cover);
      }
    },
    lyricsProps: {
      lyrics,
      lyricsCheck,
      onChange: setLyrics,
      onPick: () => pickText(setLyrics, 'Файл с текстом песни'),
      onDrop: (paths: string[]) => importText(setLyrics, paths[0])
    },
    ideaProps: {
      idea,
      onChange: setIdea,
      onPick: () => pickText(setIdea, 'Файл с описанием идеи'),
      onDrop: (paths: string[]) => importText(setIdea, paths[0])
    },
    referencesProps: {
      refs,
      kinds,
      fileUrl,
      onAdd: addReference,
      onUpdate: updateRef,
      onRetryFilePrompt: retryFilePrompt,
      onRemove: (key: number) => setRefs((current) => current.filter((ref) => ref.key !== key)),
      onAddFiles: addFiles,
      onDropFiles: appendFiles,
      onUpdateFile: updateFile,
      onRemoveFile: removeFile,
      onRemoveKind: removeKind,
      onAddKind: () => setKindDialog({ label: '', id: '', dir: '' })
    },
    kindDialogProps: { value: kindDialog, onChange: setKindDialog, onClose: () => setKindDialog(null), onAdd: addKind }
  };
}
