/** При смене папки страницы создаются заново: черновики и диалоги принадлежат одному клипу. */
import { Fragment, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useApp } from '../state';
import { HomeRedirect } from './HomeRedirect';

export function RequireProject({ children }: { children: ReactElement }): ReactElement {
  const { state, loading } = useApp();
  if (loading) return <HomeRedirect />;
  return state?.current ? <Fragment key={state.current}>{children}</Fragment> : <Navigate to="/projects" replace />;
}
