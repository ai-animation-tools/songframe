/**
 * Проверка сохранённых образов перед описанием плана: одним бесплатным списком образов (savedLooks.shot) узнаёт,
 * у кого из сущностей «В кадре» нет образа для модели плана, и при необходимости спрашивает перед запуском агента
 * описания или окна своего описания. Сбой проверки не мешает описанию: образы при сборке запроса проверит Go.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { descriptionLooksQuestion, type DescriptionLooksQuestion } from '@shared/saved-looks';
import { linkLocation, referenceAnchor } from '../../components/linkTargets';
import { SavedLooksBeforeDialog } from './components/SavedLooksBeforeDialog';

export interface SavedLooksCheck {
  /** Проверить образы и выполнить proceed сразу или после ответа «Продолжить»; agent — продолжение запускает агента. */
  check(proceed: () => void, agent: boolean): void;
  /** Идёт проверка: кнопки описания ждут её. */
  checking: boolean;
  dialog: ReactElement;
}

/** attempt — выбранная попытка плана: если за время проверки она сменилась (появилась попытка), ответ отбрасывается. */
export function useSavedLooksCheck(project: string, shot: string, attempt: string): SavedLooksCheck {
  const navigate = useNavigate();
  const location = useLocation();
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<{ question: DescriptionLooksQuestion; proceed(): void; agent: boolean } | null>(null);
  // Ответ проверки прежнего плана, проекта или попытки не открывает вопрос и не запускает описание у нового.
  const key = `${project}\n${shot}\n${attempt}`;
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
    setPending(null);
    setChecking(false);
  }, [key]);
  const check = (proceed: () => void, agent: boolean): void => {
    if (checking || pending) return;
    setChecking(true);
    const finish = (question: DescriptionLooksQuestion | null): void => {
      if (current.current !== key) return;
      setChecking(false);
      if (question) setPending({ question, proceed, agent });
      else proceed();
    };
    window.api.savedLooks.shot(project, shot).then(
      (view) => finish(descriptionLooksQuestion(view)),
      () => finish(null)
    );
  };
  const dialog = (
    <SavedLooksBeforeDialog
      question={pending?.question ?? null}
      agent={!!pending?.agent}
      onOpenReference={(code) => {
        setPending(null);
        navigate(linkLocation({ path: '/project/sources', anchor: referenceAnchor(code) }, location));
      }}
      onContinue={() => {
        const proceed = pending?.proceed;
        setPending(null);
        proceed?.();
      }}
      onClose={() => setPending(null)}
    />
  );
  return { check, checking, dialog };
}
