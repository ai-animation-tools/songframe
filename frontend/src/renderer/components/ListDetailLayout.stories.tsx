/** Список и карточка: разделитель меняет ширину списка, сетка карточек добавляет колонки, ширина переживает новое открытие. */
import { useEffect, useState, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Box, Button, Paper, Typography } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { ListDetailLayout } from './ListDetailLayout';

const KEY = 'storybook.list-detail.width';
const REMOUNT = 'Открыть заново';

/** Ширина начинается с значения по умолчанию; кнопка монтирует разметку заново, как новый запуск страницы. */
function Harness({ selected }: { selected: boolean }): ReactElement {
  const [generation, setGeneration] = useState(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Витрина без хранилища начинает с ширины по умолчанию.
    }
    return 0;
  });
  useEffect(
    () => () => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Нечего убирать.
      }
    },
    []
  );
  return (
    <Box>
      <Button onClick={() => setGeneration((value) => value + 1)}>{REMOUNT}</Button>
      <ListDetailLayout
        key={generation}
        storageKey={KEY}
        defaultWidth={280}
        stickyTop={64}
        list={
          <Box data-testid="list-grid" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: 1.5 }}>
            {['M01', 'M02', 'M03', 'M04', 'M05', 'M06'].map((id) => (
              <Paper key={id} variant="outlined" data-testid="list-card" sx={{ p: 2, height: 120 }}>
                {id}
              </Paper>
            ))}
          </Box>
        }
        detail={
          selected ? (
            <Paper variant="outlined" sx={{ p: 2, minHeight: 400 }}>
              <Typography variant="h6">M02</Typography>
            </Paper>
          ) : null
        }
      />
    </Box>
  );
}

/** Сколько карточек стоит в первом ряду сетки. */
function firstRow(canvasElement: HTMLElement): number {
  const cards = within(canvasElement).getAllByTestId('list-card');
  const top = cards[0].getBoundingClientRect().top;
  return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 1).length;
}

const meta = {
  title: 'Общие/Список и карточка',
  component: Harness,
  tags: ['!autodocs'],
  args: { selected: true },
  parameters: { controls: { disable: true }, songframe: { workspaceWidth: 1500 } }
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Resize: Story = {
  name: 'Ширина списка · разделитель, колонки карточек и запоминание',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('separator', { name: commonTexts.listDetail.split });
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await expect(firstRow(canvasElement)).toBe(1);
    // Shift+стрелка — шаг 40 px; End — предел, при котором карточке остаётся минимальная ширина.
    handle.focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    await expect(handle).toHaveAttribute('aria-valuenow', '360');
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(firstRow(canvasElement)).toBeGreaterThanOrEqual(2));
    const widest = handle.getAttribute('aria-valuenow');
    await userEvent.keyboard('{ArrowLeft}');
    await expect(handle).toHaveAttribute('aria-valuenow', String(Number(widest) - 10));
    // Щелчок мышью по разделителю даёт ему фокус: дальше работают стрелки.
    handle.blur();
    await userEvent.click(handle);
    await userEvent.keyboard('{ArrowLeft}');
    await expect(handle).toHaveAttribute('aria-valuenow', String(Number(widest) - 20));
    // Новое открытие страницы берёт сохранённую ширину.
    await userEvent.click(canvas.getByRole('button', { name: REMOUNT }));
    await expect(canvas.getByRole('separator', { name: commonTexts.listDetail.split })).toHaveAttribute('aria-valuenow', String(Number(widest) - 20));
  }
};

export const NothingSelected: Story = {
  name: 'Ничего не выбрано · список во всю ширину без разделителя',
  args: { selected: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('separator')).not.toBeInTheDocument();
    await expect(firstRow(canvasElement)).toBeGreaterThanOrEqual(4);
  }
};

export const Narrow: Story = {
  name: 'Узкая рабочая область · карточка под списком, разделителя нет',
  parameters: { songframe: { workspaceWidth: 1000 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('separator')).not.toBeInTheDocument();
    await expect(within(canvasElement).getByText('M02', { selector: 'h6' })).toBeVisible();
  }
};
