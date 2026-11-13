/**
 * Разметка «список и выбранная карточка»: страницы «Производство» и «Сцены». В широкой рабочей
 * области (контейнер workspace от 1100 px) слева список, справа карточка выбранного элемента,
 * между ними вертикальный разделитель. Ширина списка меняется перетаскиванием или стрелками и
 * запоминается под storageKey между запусками; сетка карточек в списке сама добавляет колонки, когда
 * ширина позволяет. Карточка закреплена под панелью действий страницы (stickyTop) и прокручивается
 * внутри себя, чтобы длинный список не уводил её из окна. Без выбранной карточки список занимает всю
 * ширину; в узкой области карточка идёт под списком, разделителя нет.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Box } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { useStoredNumber } from '../hooks/useStoredNumber';
import { SplitHandle } from './SplitHandle';

const WIDE = '@container workspace (min-width: 1100px)';
const HANDLE = 12;
const GAP = 8;

export function ListDetailLayout({
  storageKey,
  defaultWidth,
  minListWidth = 240,
  minDetailWidth = 600,
  stickyTop,
  list,
  detail
}: {
  /** Ключ localStorage ширины списка, свой у каждой страницы. */
  storageKey: string;
  /** Ширина списка, пока пользователь её не менял, px. */
  defaultWidth: number;
  minListWidth?: number;
  /** Карточке остаётся не меньше этой ширины, px: список не вытесняет её при узком окне. */
  minDetailWidth?: number;
  /** Отступ закреплённой карточки и разделителя от верха окна, px. */
  stickyTop: number;
  list: ReactNode;
  /** Карточка выбранного элемента; null — ничего не выбрано. */
  detail: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const [containerWidth, setContainerWidth] = useState(0);
  const [stored, setStored] = useStoredNumber(storageKey, defaultWidth, (value) => value > 0);
  const hasDetail = detail !== null && detail !== undefined && detail !== false;
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const update = (): void => setContainerWidth(box.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Сохранённая ширина не меняется от узкого окна: при расширении список возвращается к ней. До первого
  // измерения предела нет: иначе первый кадр сжал бы список, и выбранная карточка прокрутилась бы мимо.
  const maxWidth = containerWidth ? Math.max(minListWidth, containerWidth - HANDLE - 2 * GAP - minDetailWidth) : Number.POSITIVE_INFINITY;
  const width = Math.min(maxWidth, Math.max(minListWidth, stored));
  const sticky = { position: 'sticky', top: stickyTop } as const;
  return (
    <Box
      ref={ref}
      style={{ '--list-width': `${width}px` } as CSSProperties}
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        rowGap: 2,
        columnGap: `${GAP}px`,
        alignItems: 'start',
        [WIDE]: hasDetail ? { gridTemplateColumns: `var(--list-width) ${HANDLE}px minmax(0, 1fr)` } : {}
      }}
    >
      <Box sx={{ minWidth: 0 }}>{list}</Box>
      {hasDetail ? (
        <>
          <SplitHandle
            orientation="vertical"
            value={width}
            min={minListWidth}
            max={maxWidth}
            controls={detailId}
            label={commonTexts.listDetail.split}
            hint={commonTexts.listDetail.splitHint}
            valueText={commonTexts.listDetail.width}
            onChange={setStored}
            sx={{ display: 'none', [WIDE]: { display: 'flex', ...sticky, height: `calc(100vh - ${stickyTop + 16}px)` } }}
          />
          <Box id={detailId} sx={{ minWidth: 0, [WIDE]: { ...sticky, maxHeight: `calc(100vh - ${stickyTop + 16}px)`, overflowY: 'auto', pr: 0.5 } }}>
            {detail}
          </Box>
        </>
      ) : null}
    </Box>
  );
}
