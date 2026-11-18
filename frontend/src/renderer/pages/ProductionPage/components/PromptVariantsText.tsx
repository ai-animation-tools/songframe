/**
 * Видеопромпт попытки или принятого комплекта. Если агент предложил к промпту на языке провайдера русский перевод,
 * оба текста показываются одним блоком с переключателем «Оригинал / Перевод»: заголовок и число символов относятся к
 * показанному варианту, отметка рядом говорит, какой вариант выбран к отправке или отправлен. Без перевода — обычный
 * текст пакета. Выбор варианта к отправке — отдельный PromptSendChoice на вопросе согласования.
 */
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Box, Chip, FormControlLabel, FormLabel, Radio, RadioGroup, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
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
          {status ? <Chip size="small" color="info" label={status} /> : null}
        </Stack>
      ) : null}
      <PackageTextSection title={title(visible.length)} text={visible} maxHeight={maxHeight} />
      {children}
    </Box>
  );
}

/** Выбор варианта видеопромпта к отправке при утверждении: оригинал (по умолчанию) или перевод. */
export function PromptSendChoice({
  value,
  disabled = false,
  onChange
}: {
  value: PromptVariant;
  disabled?: boolean;
  onChange(variant: PromptVariant): void;
}): ReactElement {
  const labelId = useId();
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }} title={texts.sendHint}>
      <FormLabel id={labelId} sx={{ color: 'text.primary', typography: 'body2' }}>
        {texts.send}
      </FormLabel>
      <RadioGroup row aria-labelledby={labelId} value={value} onChange={(event) => onChange(event.target.value as PromptVariant)}>
        <FormControlLabel value="original" disabled={disabled} control={<Radio size="small" />} label={texts.sendOriginal} />
        <FormControlLabel value="translation" disabled={disabled} control={<Radio size="small" />} label={texts.sendTranslation} />
      </RadioGroup>
    </Stack>
  );
}
