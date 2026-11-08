/** Конструктор собирает только выбранные разделы; ручной текст никогда не заменяется ответом чтения контекста. */
import { useEffect, useRef, useState } from 'react';
import type { ReferenceImageContext, ReferenceImageContextDrafts } from '@shared/reference-image-generation';
import { sourcesTexts } from '@shared/texts/sources';
import { useApp } from '../state';

export type ReferenceSection = 'clipName' | 'lyrics' | 'idea' | 'description' | 'visualStyle' | 'supportNotes';
export type ReferenceSections = Record<ReferenceSection, boolean>;
export const DEFAULT_REFERENCE_SECTIONS: ReferenceSections = {
  clipName: false,
  lyrics: false,
  idea: false,
  description: true,
  visualStyle: false,
  supportNotes: false
};
export const REFERENCE_SECTION_LABELS: Record<ReferenceSection, string> = {
  clipName: sourcesTexts.referenceClipName,
  lyrics: sourcesTexts.referenceLyrics,
  idea: sourcesTexts.referenceIdea,
  description: sourcesTexts.referenceDescription,
  visualStyle: sourcesTexts.referenceVisualStyle,
  supportNotes: sourcesTexts.referenceSupportNotesSection
};
export const REFERENCE_SECTION_ORDER: ReferenceSection[] = ['clipName', 'lyrics', 'idea', 'description', 'visualStyle', 'supportNotes'];

/** Контекст здесь обычный текст: выключенный раздел не попадает в запрос даже скрытым приложением. */
export function composeReferencePrompt(
  base: string,
  description: string,
  context: ReferenceImageContext | null,
  sections: ReferenceSections,
  supportNotes = ''
): string {
  return [
    base,
    ...REFERENCE_SECTION_ORDER.flatMap((key) => {
      const value = key === 'description' ? description : key === 'supportNotes' ? supportNotes : (context?.[key] ?? '');
      return sections[key] && value.trim() ? [`${REFERENCE_SECTION_LABELS[key]}:\n${value}`] : [];
    })
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function useReferenceImageComposer({
  enabled,
  project,
  basePrompt,
  description = '',
  supportNotes = '',
  drafts
}: {
  enabled: boolean;
  project: string;
  basePrompt: string;
  description?: string;
  supportNotes?: string;
  drafts?: ReferenceImageContextDrafts;
}) {
  const { describeError } = useApp();
  const [context, setContext] = useState<ReferenceImageContext | null>(null);
  const [sections, setSections] = useState<ReferenceSections>({ ...DEFAULT_REFERENCE_SECTIONS });
  const selected = useRef(sections);
  const [prompt, setPrompt] = useState(() => composeReferencePrompt(basePrompt, description, null, DEFAULT_REFERENCE_SECTIONS, supportNotes));
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const draftIdea = drafts?.idea;
  const draftLyrics = drafts?.lyrics;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api.referenceImages
      .context(project, draftIdea === undefined && draftLyrics === undefined ? undefined : { idea: draftIdea, lyrics: draftLyrics })
      .then((next) => {
        if (cancelled) return;
        setContext(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(describeError(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Черновики сравниваются по тексту: пересоздание объекта props не перечитывает контекст на каждый render.
  }, [enabled, project, basePrompt, description, draftIdea, draftLyrics, attempt, describeError]);

  const edit = (value: string): void => {
    manualRef.current = true;
    setManual(true);
    setPrompt(value);
  };
  const change = (key: ReferenceSection, checked: boolean): void => {
    if (manualRef.current) return;
    const next = { ...selected.current, [key]: checked };
    selected.current = next;
    setSections(next);
  };
  const rebuild = (): void => {
    manualRef.current = false;
    setManual(false);
  };
  // Сборка синхронна выбору опор; ручной итог хранится отдельно от автоматически вычисляемого текста.
  const currentPrompt = manual ? prompt : composeReferencePrompt(basePrompt, description, context, sections, supportNotes);
  return {
    context,
    supportNotes,
    sections,
    prompt: currentPrompt,
    manual,
    loading,
    error,
    ready: context !== null || manual,
    edit,
    change,
    rebuild,
    withoutContext: () => edit(currentPrompt),
    retry: () => setAttempt((current) => current + 1)
  };
}
