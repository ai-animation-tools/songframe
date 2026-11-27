/** Ссылка на статью справки: переход на «Справку» с прокруткой к статье и её подсветкой (общий ?anchor=). */
import type { ReactElement, ReactNode } from 'react';
import { Link } from '@mui/material';
import { Link as RouterLink, useInRouterContext, useLocation } from 'react-router-dom';
import { linkLocation } from './linkTargets';

interface Props {
  /** ID статьи в GLOSSARY: он же якорь её карточки. */
  article: string;
  children: ReactNode;
}

export function HelpArticleLink({ article, children }: Props): ReactElement {
  // Вне маршрутизатора (изолированный блок) переходить некуда: остаётся текст.
  return useInRouterContext() ? <RoutedHelpLink article={article}>{children}</RoutedHelpLink> : <>{children}</>;
}

function RoutedHelpLink({ article, children }: Props): ReactElement {
  const location = useLocation();
  return (
    <Link component={RouterLink} to={linkLocation({ path: '/help', anchor: article }, location)} color="inherit" underline="always">
      {children}
    </Link>
  );
}
