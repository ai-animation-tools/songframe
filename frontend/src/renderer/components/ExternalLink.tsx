/**
 * Ссылка на веб-страницу вне приложения. Встроенное окно Wails переход по target="_blank" в браузер ОС не передаёт,
 * поэтому щелчок открывает адрес через window.api.shell.openExternal; href и target остаются для доступного имени,
 * подсказки адреса и копирования ссылки. Ошибка открытия показывается уведомлением приложения.
 */
import type { MouseEvent, ReactElement } from 'react';
import { Link, type LinkProps } from '@mui/material';
import { useOptionalApp } from '../state';

export function ExternalLink({ href, onClick, ...props }: Omit<LinkProps, 'href' | 'target' | 'rel'> & { href: string }): ReactElement {
  const app = useOptionalApp();
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    window.api.shell.openExternal(href).catch((error: unknown) => app?.notify(app.describeError(error), 'error'));
  };
  return <Link {...props} href={href} target="_blank" rel="noreferrer" onClick={open} />;
}
