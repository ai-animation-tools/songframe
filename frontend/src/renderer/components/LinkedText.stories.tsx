/** Текущий маршрут показывает фактический результат перехода без настоящего приложения. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLocation } from 'react-router-dom';
import { Alert, Stack } from '@mui/material';
import type { StoryOptions } from '../testing/storybook';
import { LinkedText } from './LinkedText';
function LinkPreview({ text }: { text: string }) {
  const location = useLocation();
  return (
    <Stack spacing={2}>
      <Alert severity="warning">
        <LinkedText text={text} />
      </Alert>
      <Alert severity="info">
        Маршрут: {location.pathname}
        {location.search}
      </Alert>
    </Stack>
  );
}
const meta: Meta<typeof LinkedText> = {
  title: 'Общие/Ссылки в сообщениях',
  component: LinkedText,
  render: (args) => <LinkPreview {...args} />,
  args: { text: 'Источник недоступен. Проверьте его на странице «Производство» или перейдите на страницу «Среда».' },
  parameters: { songframe: { route: '/project/scenes?shot=M01' } satisfies StoryOptions }
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Navigation: Story = { name: 'Переходы по страницам' };
export const Plain: Story = { name: 'Текст без ссылок', args: { text: 'Предпросмотр устарел: источник изменился. После проверки соберите новый результат.' } };
