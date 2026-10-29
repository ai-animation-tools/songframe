import type { OpenShotState } from '../types';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import EditNoteIcon from '@mui/icons-material/EditNote';
import GroupsIcon from '@mui/icons-material/Groups';
import type { StateSource } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { castEntityRoute } from '../../../components/castRoutes';
import { sourceLabel } from '../briefComparison';

/** Где задано значение врезки, с переходом к месту правки: блок состояния плана на этой странице или карточка на «Кастинге». */
export function BriefSourceLink({
  source,
  entity,
  entityName,
  currentShot,
  leaveReason,
  onOpenShotState
}: {
  source: StateSource;
  entity: string;
  entityName: string;
  currentShot: string;
  /** Уход на «Кастинг» сбросит несохранённые черновики страницы: тогда переход недоступен. */
  leaveReason: string | null;
  onOpenShotState: OpenShotState;
}): ReactElement {
  const navigate = useNavigate();
  const plan = source.kind === 'plan';
  const block = source.kind === 'plan' ? (source.phase === 'before' ? '«Первый кадр (before)»' : '«Итог плана (after)»') : '';
  const title =
    source.kind === 'cast'
      ? `Открыть начальное состояние «${entityName}» на странице «Кастинг»`
      : source.shot === currentShot
        ? `Прокрутить к блоку «Состояние героев и мира» этого плана: значение задано в ${block}`
        : `Открыть план ${source.shot} и его блок «Состояние героев и мира»: значение задано в ${block}`;
  return (
    <ActionButton
      size="small"
      color={plan ? 'primary' : 'inherit'}
      startIcon={plan ? <EditNoteIcon /> : <GroupsIcon />}
      title={title}
      disabled={!plan && !!leaveReason}
      disabledReason={leaveReason}
      onClick={() => (source.kind === 'plan' ? onOpenShotState(source.shot, entity, source.phase) : navigate(castEntityRoute(entity)))}
      // Ссылка-источник стоит в каждой ячейке: компактнее обычной кнопки, но с иконкой и подписью.
      sx={{
        minWidth: 0,
        px: 0.5,
        py: 0,
        fontSize: 12,
        lineHeight: 1.6,
        textTransform: 'none',
        color: plan ? undefined : 'text.secondary',
        '& .MuiButton-startIcon': { mr: 0.5, '& > *:nth-of-type(1)': { fontSize: 16 } }
      }}
    >
      {sourceLabel(source)}
    </ActionButton>
  );
}
