/** Текст сообщения, в котором отсылки «на странице «…»», «в блоке «…»» становятся ссылками с переходом и прокруткой к цели. */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Link } from '@mui/material';
import { Link as RouterLink, useInRouterContext, useLocation } from 'react-router-dom';
import { linkLocation, linkSegments } from './linkTargets';

interface LinkedTextProps {
  text: string;
  /** Оформление частей текста, например подсветка найденных слов; по умолчанию текст как есть. */
  renderText?: (text: string) => ReactNode;
}

const plain = (value: string): ReactNode => value;

export function LinkedText(props: LinkedTextProps): ReactElement {
  // Вне маршрутизатора (отдельное окно, изолированный тест блока) переходить некуда: текст остаётся обычным.
  return useInRouterContext() ? <RoutedLinkedText {...props} /> : <>{(props.renderText ?? plain)(props.text)}</>;
}

function RoutedLinkedText({ text, renderText }: LinkedTextProps): ReactElement {
  const location = useLocation();
  const render = renderText ?? plain;
  return (
    <>
      {linkSegments(text, location.pathname).map((segment, index) =>
        segment.target ? (
          // Цвет текста наследуется: ссылка читается и в filled-уведомлении, и в Alert любого состояния.
          <Link
            key={index}
            component={RouterLink}
            to={linkLocation(segment.target, location)}
            replace={segment.target.path === location.pathname}
            color="inherit"
            underline="always"
          >
            {render(segment.text)}
          </Link>
        ) : (
          <Fragment key={index}>{render(segment.text)}</Fragment>
        )
      )}
    </>
  );
}
