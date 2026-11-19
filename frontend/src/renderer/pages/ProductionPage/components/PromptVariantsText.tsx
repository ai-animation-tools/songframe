/**
 * Видеопромпт попытки или принятого комплекта. Если агент предложил к промпту на языке провайдера русский перевод,
 * оба текста показываются одним блоком с переключателем «Оригинал / Перевод»: заголовок и число символов относятся к
 * показанному варианту, отметка рядом говорит, какой вариант выбран к отправке или отправлен. Без перевода — обычный
 * текст пакета. На согласовании переключатель и есть выбор отправки: родитель передаёт shown и onShownChange,
 * а показанный вариант уходит в утверждение. В утверждённом промпте и принятом комплекте он только для просмотра.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Box, Chip, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { productionTexts } from '@shared/texts/production';
import type { PromptVariant } from '@shared/types';
import { PackageTextSection } from './PackageTextSection';

const texts = productionTexts.promptVariants;

/** Тексты вариантов видеопромпта: оригинал и перевод. */
export interface PromptTexts {
  original: string;
  translation: string;
}

/** Текст варианта variant; без вариантов — единственный текст. */
export function promptVariantText(text: string, variants: PromptTexts | undefined, variant: PromptVariant): string {
  if (!variants) return text;
  return variant === 'translation' ? variants.translation : variants.original;
}

export function PromptVariantsText({
  text,
  variants,
  title,
  status,
  statusHint,
  shown,
  onShownChange,
  maxHeight,
  children
}: {
  /** Текст без вариантов (или выбранный к отправке, если варианты есть). */
  text: string;
  variants?: PromptTexts;
  /** Заголовок блока по числу символов показанного текста. */
  title(characters: number): string;
  /** Отметка выбранного или отправленного варианта; без неё отметки нет. */
  status?: string;
  /** Подсказка отметки: например, что показанный вариант уйдёт в запрос видео. */
  statusHint?: string;
  /** Показанный вариант, если им управляет родитель; иначе блок помнит его сам, начиная с оригинала. */
  shown?: PromptVariant;
  onShownChange?(variant: PromptVariant): void;
  /** Предел высоты текста; без него текст прокручивает родитель. */
  maxHeight?: number;
  /** Действия под текстом, например «Скопировать» показанного варианта. */
  children?: ReactNode;
}): ReactElement {
  const [own, setOwn] = useState<PromptVariant>('original');
  const view = shown ?? own;
  const visible = promptVariantText(text, variants, view);
  const show = (next: PromptVariant): void => {
    setOwn(next);
    onShownChange?.(next);
  };
  return (
    <Box>
      {variants ? (
        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={view}
            aria-label={texts.view}
            onChange={(_event, next: PromptVariant | null) => {
              if (next) show(next);
            }}
          >
            <ToggleButton value="original" title={texts.originalHint}>
              {texts.original}
            </ToggleButton>
            <ToggleButton value="translation" title={texts.translationHint}>
              {texts.translation}
            </ToggleButton>
          </ToggleButtonGroup>
          {status ? <Chip size="small" color="info" label={status} title={statusHint} /> : null}
        </Stack>
      ) : null}
      <PackageTextSection title={title(visible.length)} text={visible} maxHeight={maxHeight} />
      {children}
    </Box>
  );
}
