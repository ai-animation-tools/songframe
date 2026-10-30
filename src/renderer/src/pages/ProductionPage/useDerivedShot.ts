import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivedShotView } from '@shared/derived-shot';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { useApp } from '../../state';
import { RequestScope } from '../../hooks/requestScope';
import { derivedActionReasons, recipeDraft, type DerivedRecipeDraft } from './derivedRecipeForm';

/** Опрос обновляет свежесть кандидата, сохраняя незавершённую правку формы. Результат сборки никогда не принимается автоматически. */
export function useDerivedShot(project: string, shot: string, onApplied: () => Promise<void>) {
  const { notify, describeError } = useApp();
  const [storedView, setView] = useState<{ key: string; view: DerivedShotView } | null>(null);
  const [draft, setDraft] = useState<DerivedRecipeDraft>(() => recipeDraft(null));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const confirmationScope = useRef(new RequestScope()).current;
  const currentConfirmation = confirmationScope.capture();
  const scope = useRef(new RequestScope()).current;
  const key = `${project}\0${shot}`;
  scope.update(key);
  const context = useMemo(() => scope.capture(key), [scope, key]);
  const mounted = useRef(true);
  const currentContext = useCallback(() => mounted.current && context(), [context]);
  // API возвращает канонический путь, который может отличаться от выбранного пути через ссылку.
  // Принадлежность ответа определяет ключ исходного запроса, а устаревшие запросы отзывает RequestScope.
  const view = storedView?.key === key && storedView.view.shot === shot ? storedView.view : null;
  const latest = useRef({ view, draft, pending });
  latest.current = { view, draft, pending };
  const operation = useRef(false);
  const version = useRef(0);
  // StrictMode повторно подключает эффекты: флаг оживает на mount, а номер запроса отзывает предыдущий опрос.
  useEffect(() => {
    mounted.current = true;
    const requests = version;
    return () => {
      mounted.current = false;
      ++requests.current;
    };
  }, []);
  const callbacks = useRef({ onApplied });
  callbacks.current = { onApplied };
  const busy = pending || view?.job?.status === 'running';
  const reasons = view ? derivedActionReasons(view, draft, busy) : null;

  const retry = useCallback(async () => {
    if (operation.current) return;
    const current = currentContext;
    if (!current()) return;
    const request = ++version.current;
    try {
      const next = await window.api.derivedShots.view(project, shot);
      if (!current() || request !== version.current || operation.current) return;
      const previous = latest.current;
      const dirty = previous.view?.shot === shot && JSON.stringify(previous.draft) !== JSON.stringify(recipeDraft(previous.view.recipe));
      setView({ key, view: next });
      if (!dirty) setDraft(recipeDraft(next.recipe));
      setError(null);
    } catch (error) {
      if (current() && request === version.current) setError(describeError(error));
    }
  }, [currentContext, project, shot, describeError, key]);

  useEffect(() => {
    operation.current = false;
    setView(null);
    setDraft(recipeDraft(null));
    setPending(false);
    setError(null);
    setReplacement(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      await retry();
      if (active) timer = setTimeout(() => void poll(), 1800);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [retry]);

  const change = (next: DerivedRecipeDraft): void => {
    if (!currentContext() || operation.current || busy) return;
    latest.current.draft = next;
    setDraft(next);
    confirmationScope.invalidate();
    setReplacement(null);
  };
  const reset = (): void => {
    if (!view || busy || operation.current || !currentContext()) return;
    latest.current.draft = recipeDraft(view.recipe);
    setDraft(latest.current.draft);
    confirmationScope.invalidate();
    setReplacement(null);
  };

  const run = async (kind: 'save' | 'build' | 'accept', replace = false): Promise<void> => {
    const current = currentContext;
    if (!current() || operation.current || !view || !reasons) return;
    const snapshot = latest.current;
    if (snapshot.view !== view) return;
    const checked = derivedActionReasons(view, snapshot.draft, snapshot.pending || view.job?.status === 'running');
    if (checked[kind] || !checked.recipe) return;
    if (kind === 'accept' && (!view.preview || (view.hasAsset && (!replace || !currentConfirmation() || replacement !== view.preview.id)))) return;
    operation.current = true;
    ++version.current;
    setPending(true);
    setError(null);
    try {
      const next = await (kind === 'save'
        ? window.api.derivedShots.save(project, shot, checked.recipe)
        : kind === 'build'
          ? window.api.derivedShots.build(project, shot, checked.recipe)
          : window.api.derivedShots.accept(project, shot, view.preview!.id, view.preview!.resultToken, replace));
      if (!current()) return;
      latest.current = { view: next, draft: recipeDraft(next.recipe), pending: true };
      setView({ key, view: next });
      setDraft(recipeDraft(next.recipe));
      setReplacement(null);
      if (kind === 'save') notify(texts.saved, 'success');
      if (kind === 'accept' && !next.job) {
        notify(texts.accepted, 'success');
        await callbacks.current.onApplied();
      }
    } catch (error) {
      // Сбой приёмки оставляет тот же кандидат: повтор не запускает сборку заново.
      if (current()) {
        const message = describeError(error);
        setError(message);
        notify(message, 'error');
      }
    } finally {
      if (current()) {
        operation.current = false;
        setPending(false);
      }
    }
  };
  const requestAccept = (): void => {
    if (
      !currentContext() ||
      operation.current ||
      !view?.preview ||
      latest.current.view !== view ||
      derivedActionReasons(view, latest.current.draft, busy).accept
    )
      return;
    if (view.hasAsset) {
      confirmationScope.invalidate();
      setReplacement(view.preview.id);
    } else void run('accept');
  };

  return {
    view,
    draft,
    busy,
    pending,
    error,
    reasons,
    retry,
    change,
    reset,
    save: () => run('save'),
    build: () => run('build'),
    requestAccept,
    replacement: !!replacement && replacement === view?.preview?.id,
    closeReplacement: () => {
      if (currentContext() && !operation.current) {
        confirmationScope.invalidate();
        setReplacement(null);
      }
    },
    confirmReplacement: () => run('accept', true)
  };
}
