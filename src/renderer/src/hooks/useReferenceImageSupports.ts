/** Читаем опоры локально: одинаковые байты получают один номер до составления видимого промпта. */
import { useEffect, useState } from 'react';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import type { ReferenceImageOption } from '@shared/reference-image-generation';
import { sourcesTexts } from '@shared/texts/sources';
import { useApp } from '../state';

/** Группировка повторяет порядок сессии; пустое примечание не сдвигает номера остальных изображений. */
export function referenceSupportNotes(options: readonly ReferenceImageOption[], images: readonly GenerationReferenceImage[]): string {
  const groups = new Map<string, { labels: string[]; notes: string[] }>();
  images.forEach((image, index) => {
    const group = groups.get(image.sha256) ?? { labels: [], notes: [] };
    const label = image.label.trim();
    const note = options[index]?.note?.trim() ?? '';
    if (!group.labels.includes(label)) group.labels.push(label);
    if (note && !group.notes.includes(note)) group.notes.push(note);
    groups.set(image.sha256, group);
  });
  return [...groups.values()]
    .flatMap((group, index) =>
      group.notes.length ? [`${sourcesTexts.referenceSupportNoteItem({ number: index + 1, label: group.labels.join(' · ') })}:\n${group.notes.join('\n')}`] : []
    )
    .join('\n\n');
}

export function useReferenceImageSupports(enabled: boolean, options: ReferenceImageOption[]) {
  const { describeError } = useApp();
  // Ключ не включает note: правка примечания не требует повторно читать те же байты.
  const key = JSON.stringify(options.map(({ path, label }) => ({ path, label })));
  const [snapshot, setSnapshot] = useState<{ key: string; images: GenerationReferenceImage[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string; restartRequired: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${key}:${attempt}`;
  useEffect(() => {
    if (!enabled || key === '[]') return;
    let cancelled = false;
    setFailure(null);
    setSnapshot(null);
    // Старый preload в dev может не иметь нового метода. Вызов входит в try вместе с await:
    // синхронный отказ и отклонённый Promise оставляют ошибку в диалоге, а не размонтируют страницу.
    void (async () => {
      let restartRequired = false;
      try {
        restartRequired = typeof window.api.referenceImages.inspect !== 'function';
        if (restartRequired) throw new Error(sourcesTexts.referenceSupportsRestartRequired);
        const images = await window.api.referenceImages.inspect({ images: JSON.parse(key) as { path: string; label: string }[] });
        if (!cancelled) setSnapshot({ key: requestKey, images });
      } catch (error) {
        if (!cancelled) setFailure({ key: requestKey, message: describeError(error), restartRequired });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, key, requestKey, describeError]);
  const images = !enabled || options.length === 0 ? [] : snapshot?.key === requestKey ? snapshot.images : null;
  const error = failure?.key === requestKey ? failure.message : null;
  return {
    ready: images !== null,
    loading: enabled && images === null && !error,
    error,
    restartRequired: failure?.key === requestKey && failure.restartRequired,
    notes: images ? referenceSupportNotes(options, images) : '',
    // Примечание никогда не передаётся в label/role; SHA связывает номера в тексте с проверенными байтами.
    input: { images: (images ?? []).map(({ path, label, sha256 }) => ({ path, label, sha256 })) },
    retry: () => setAttempt((current) => current + 1)
  };
}
