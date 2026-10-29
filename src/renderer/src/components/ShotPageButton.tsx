/** Переход к тому же плану на другой странице: «В сценарии» открывает редактор его постановки, «В производстве» — его пакеты. */
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import BuildIcon from '@mui/icons-material/Build';
import TheatersIcon from '@mui/icons-material/Theaters';
import { ActionButton } from './ActionButton';
import { shotPageRoute, type ShotPage } from './shotRoutes';

// Значки те же, что у страниц в боковой навигации.
const PAGES: Record<ShotPage, { label: string; title: string; icon: ReactElement }> = {
  production: { label: 'В производстве', title: 'на странице «Производство»', icon: <BuildIcon /> },
  scenario: { label: 'В сценарии', title: 'в реестре сцен на странице «Сценарий»', icon: <TheatersIcon /> }
};

export function ShotPageButton({
  page,
  shot,
  size = 'small',
  disabledReason
}: {
  page: ShotPage;
  shot: string;
  /** Размер соседних кнопок ряда; по умолчанию компактный, как на странице «Сцены». */
  size?: 'small' | 'medium';
  /** Что мешает уйти со страницы и что сделать; при причине кнопка выключена. */
  disabledReason?: string | null;
}): ReactElement {
  const navigate = useNavigate();
  const { label, title, icon } = PAGES[page];
  return (
    <ActionButton
      startIcon={icon}
      size={size}
      variant="outlined"
      title={`Открыть план ${shot} ${title}`}
      disabled={!!disabledReason}
      disabledReason={disabledReason}
      onClick={() => navigate(shotPageRoute(page, shot))}
    >
      {label}
    </ActionButton>
  );
}
