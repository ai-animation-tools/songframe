import type { Preview } from '@storybook/react-vite';
import { createStoryApi, type StoryOptions } from '@renderer/testing/storybook';
import { StoryEnvironment } from './StoryEnvironment';

let apiRevision = 0;

const preview: Preview = {
  tags: ['autodocs'],
  initialGlobals: { theme: 'light', workspace: '1084' },
  globalTypes: {
    theme: {
      description: 'Тема приложения',
      toolbar: {
        icon: 'paintbrush',
        dynamicTitle: true,
        items: [
          { value: 'light', title: 'Светлая тема' },
          { value: 'dark', title: 'Тёмная тема' }
        ]
      }
    },
    workspace: {
      description: 'Ширина рабочей области с учётом меню приложения',
      toolbar: {
        icon: 'browser',
        dynamicTitle: true,
        items: [
          { value: '724', title: 'Окно 960: область 724 px' },
          { value: '1084', title: 'Окно 1320: область 1084 px' },
          { value: '900', title: 'Область 900 px' },
          { value: '1100', title: 'Область 1100 px' },
          { value: '1600', title: 'Область 1600 px' }
        ]
      }
    }
  },
  parameters: {
    layout: 'fullscreen',
    // Каждая Docs-история получает свой iframe и собственный window.api.
    docs: { story: { inline: false, height: '720px' } },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    // Обязательные для CI правила — WCAG 2.x уровней A и AA; рекомендации axe (best-practice) остаются за ручным просмотром.
    a11y: { options: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } } }
  },
  beforeEach(context) {
    const options: StoryOptions = context.parameters.songframe ?? {};
    const configured = options.createApi?.() ?? {};
    const session = 'api' in configured ? configured : createStoryApi(configured);
    const previous = Object.getOwnPropertyDescriptor(window, 'api');
    // Установка до первого JSX необходима синхронному shell.fileUrl в media-компонентах.
    Object.defineProperty(window, 'api', { configurable: true, writable: true, value: session.api });
    // Storybook повторяет beforeEach при смене globals: новая модель требует нового состояния hooks.
    apiRevision += 1;
    return () => {
      session.dispose();
      // Поздний cleanup старого render не подменяет API уже открытой истории.
      if (window.api !== session.api) return;
      if (previous) Object.defineProperty(window, 'api', previous);
      else Reflect.deleteProperty(window, 'api');
    };
  },
  decorators: [
    (Story, context) => {
      const options: StoryOptions = context.parameters.songframe ?? {};
      return (
        <StoryEnvironment
          key={`${context.id}:${apiRevision}`}
          options={options}
          mode={context.globals.theme === 'dark' ? 'dark' : 'light'}
          width={Number(context.globals.workspace) || 1084}
        >
          <Story />
        </StoryEnvironment>
      );
    }
  ]
};

export default preview;
