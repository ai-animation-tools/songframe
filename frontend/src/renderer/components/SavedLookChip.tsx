/** Заметный статус сохранённого образа референса: один вид на «Исходниках» и в кастинге. Только показывает статус: чип стоит в заголовках-кнопках карточек, вложенный элемент управления там недопустим. */
import type { ReactElement } from 'react';
import { Chip, Tooltip } from '@mui/material';
import type { SavedLookState } from '@shared/saved-looks';
import { savedLooksTexts } from '@shared/texts/saved-looks';

const COLORS = { none: 'default', ready: 'success', stale: 'warning', missing: 'error' } as const;

export function SavedLookChip({ state }: { state: SavedLookState }): ReactElement {
  const label = state.name && state.status !== 'none' ? `${savedLooksTexts.status[state.status]}: ${state.name}` : savedLooksTexts.status[state.status];
  // describeChild: пояснение — описание, а не имя: видимый текст чипа остаётся его именем.
  return (
    <Tooltip title={savedLooksTexts.statusHint[state.status]} describeChild>
      <Chip size="small" color={COLORS[state.status]} variant={state.status === 'none' ? 'outlined' : 'filled'} label={label} />
    </Tooltip>
  );
}
