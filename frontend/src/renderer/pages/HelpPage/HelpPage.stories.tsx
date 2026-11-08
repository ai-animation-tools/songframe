/** Настоящая справка работает без проекта и API; поиск сохраняет нейтральные статьи и имена из реестра. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS } from '@shared/agent-providers';
import type { StoryOptions } from '../../testing/storybook';
import { HelpPage } from './HelpPage';

const meta = {
  title: 'Страницы/Справка',
  component: HelpPage,
  tags: ['!autodocs'],
  parameters: { songframe: { route: '/help', shell: 'page' } satisfies StoryOptions }
} satisfies Meta<typeof HelpPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NeutralInstructions: Story = {
  name: 'Общие инструкции · агент и медиапровайдер',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox', { name: 'Поиск по справке' });
    await userEvent.type(search, 'предложения ИИ');
    const setup = canvasElement.querySelector('#agent-setup');
    await expect(setup).toHaveTextContent('Установите и авторизуйте внешнего агента, затем выберите его в «Настройках» и проверьте доступность.');
    await userEvent.clear(search);
    await userEvent.type(search, 'Подготовка приложения и вход');
    const environment = canvasElement.querySelector('#environment-check');
    await expect(environment).toHaveTextContent('Внешнего агента нужно установить и авторизовать отдельно, если нужны его предложения.');
    await expect(environment).toHaveTextContent('Внешний агент запускается из приложения в Linux и Windows.');
    await userEvent.clear(search);
    await userEvent.type(search, 'провайдер');
    const provider = canvasElement.querySelector('#provider');
    await expect(provider).toHaveTextContent('Провайдер изображений, которого исполняет программа-агент, доступен при любом выбранном агенте и без агента');
    // Имена допустимы в найденных синонимах, а общие объяснения не зависят от состава реестра.
    for (const id of AGENT_PROVIDER_IDS) {
      await expect(setup?.textContent ?? '').not.toContain(AGENT_PROVIDERS[id].title);
      await expect(environment?.textContent ?? '').not.toContain(AGENT_PROVIDERS[id].title);
      await expect(provider).not.toHaveTextContent(AGENT_PROVIDERS[id].title);
    }
  }
};

export const SearchByAgentName: Story = {
  name: 'Поиск по имени агента из реестра',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const search = within(canvasElement).getByRole('searchbox', { name: 'Поиск по справке' });
    for (const id of AGENT_PROVIDER_IDS) {
      await userEvent.clear(search);
      await userEvent.type(search, AGENT_PROVIDERS[id].title);
      for (const articleId of ['agent', 'agent-setup']) {
        const article = canvasElement.querySelector(`#${articleId}`);
        await expect(article).toBeVisible();
        await expect(article).toHaveTextContent(`Также называется: ${AGENT_PROVIDERS[id].title}`);
      }
    }
  }
};
