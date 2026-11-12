/** Способ генерации видео попытки: выбор и причина недоступности; выбранный способ остаётся только в памяти истории. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Stack, Typography } from '@mui/material';
import type { ProductionGenerationMethod } from '@shared/production-workflow';
import { productionTexts } from '@shared/texts/production';
import { GenerationMethodChoice } from './GenerationMethodChoice';

const texts = productionTexts.generationMethod;
const LOCKED = 'Сначала ответьте на вопрос пакета.';

function MethodStory({ reason = null }: { reason?: string | null }) {
  const [method, setMethod] = useState<ProductionGenerationMethod>('provider');
  return (
    <Stack spacing={2}>
      <GenerationMethodChoice method={method} disabledReason={reason} onChange={setMethod} />
      <Typography data-testid="method">Способ: {method}.</Typography>
    </Stack>
  );
}

const meta = {
  title: 'Производство/Видеопромпт/Способ генерации',
  component: MethodStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof MethodStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Choose: Story = {
  name: 'Выбор · провайдер проекта или вручную вне приложения',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(texts.hint)).toBeVisible();
    await expect(canvas.getByRole('radio', { name: new RegExp(texts.provider) })).toBeChecked();
    await userEvent.click(canvas.getByRole('radio', { name: new RegExp(texts.manual) }));
    await expect(canvas.getByTestId('method')).toHaveTextContent('Способ: manual.');
    await userEvent.click(canvas.getByRole('radio', { name: new RegExp(texts.provider) }));
    await expect(canvas.getByTestId('method')).toHaveTextContent('Способ: provider.');
  }
};

export const Locked: Story = {
  name: 'Недоступно · причина вместо подсказки',
  args: { reason: LOCKED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(LOCKED)).toBeVisible();
    await expect(canvas.getByRole('radio', { name: new RegExp(texts.manual) })).toBeDisabled();
  }
};
