/** Диалог размонтируется при закрытии, а решение остаётся только в памяти истории. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack, Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';
import type { KeyframeNoteScope } from '@shared/types';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { ActionButton } from '../../../components/ActionButton';
import { KeyframeReopenDialog } from './KeyframeReopenDialog';

const NOTE = 'Сохранить куртку героя и тёплый вечерний свет из предыдущей опоры.';
const LONG_NOTE = Array.from(
  { length: 10 },
  (_, index) =>
    `${index + 1}. Сохранить одежду и лицо героя, следы грязи на рукаве и направление вечернего света. Не менять положение ворот, силуэт машины и расстояние до забора.`
).join('\n');
const EMPTY_RESULT = 'Решение ещё не сохранено.';
const CANCELLED = 'Диалог закрыт без сохранения.';

interface ReopenStoryProps {
  frame: string;
}

interface SavedDecision {
  note: string;
  scope: KeyframeNoteScope;
}

function ReopenStory({ frame }: ReopenStoryProps) {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<SavedDecision | null>(null);
  const [cancelled, setCancelled] = useState(false);
  return (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>
        {frame}
      </Typography>
      <Alert severity={saved ? 'success' : 'info'} role="status">
        {saved ? (
          <Stack spacing={1}>
            <Typography>Решение сохранено в памяти истории.</Typography>
            <Typography>
              {saved.scope === 'following' ? productionTexts.keyframeNotes.followingFrames({ frame }) : productionTexts.keyframeNotes.singleFrame({ frame })}
            </Typography>
            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.note}</Typography>
          </Stack>
        ) : (
          EMPTY_RESULT
        )}
      </Alert>
      {cancelled && <Alert severity="info">{CANCELLED}</Alert>}
      <div>
        <ActionButton
          startIcon={<ReplayIcon />}
          onClick={() => {
            setCancelled(false);
            setOpen(true);
          }}
        >
          {productionTexts.keyframeReopenDialog.confirm}
        </ActionButton>
      </div>
      {open && (
        <KeyframeReopenDialog
          frame={frame}
          onClose={() => {
            setCancelled(true);
            setOpen(false);
          }}
          onConfirm={(note, scope) => {
            setSaved({ note, scope });
            setCancelled(false);
            setOpen(false);
          }}
        />
      )}
    </Stack>
  );
}

const meta = {
  title: 'Производство/Опоры/Возврат на доработку',
  component: ReopenStory,
  // Автофокус и клавиатурные сценарии запускаются только в отдельном Canvas.
  tags: ['!autodocs'],
  args: { frame: 'K02' },
  render: (args) => <ReopenStory key={args.frame} {...args} />
} satisfies Meta<typeof ReopenStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: PlayContext) => within(canvasElement.ownerDocument.body);

async function dialogOf(context: PlayContext) {
  return within(await screenOf(context).findByRole('dialog', { name: productionTexts.keyframeReopenDialog.title({ frame: context.args.frame }) }));
}

async function expectCleanForm(context: PlayContext): Promise<void> {
  const dialog = await dialogOf(context);
  const input = dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note });
  await expect(input).toHaveValue('');
  await expect(dialog.getByRole('checkbox', { name: productionTexts.keyframeNoteScopeField.following })).toBeChecked();
  await expect(dialog.getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm })).toBeDisabled();
  await waitFor(() => expect(input).toHaveFocus());
}

async function reopen(context: PlayContext): Promise<void> {
  await userEvent.click(within(context.canvasElement).getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm }));
  await expectCleanForm(context);
}

async function confirm(context: PlayContext, scope: KeyframeNoteScope): Promise<void> {
  const dialog = await dialogOf(context);
  await userEvent.type(dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note }), `  ${NOTE}  `);
  if (scope === 'frame') await userEvent.click(dialog.getByRole('checkbox', { name: productionTexts.keyframeNoteScopeField.following }));
  await expect(
    dialog.getByText(scope === 'following' ? productionTexts.keyframeNoteScopeField.followingHint : productionTexts.keyframeNoteScopeField.singleHint)
  ).toBeInTheDocument();
  await expect(dialog.getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm })).toBeEnabled();
  await userEvent.click(dialog.getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm }));
  const result = await within(context.canvasElement).findByRole('status');
  const note = within(result).getByText(NOTE);
  // Точное значение callback проверяется без нормализации пробелов Testing Library.
  await expect(note.textContent).toBe(NOTE);
  await expect(result).toHaveTextContent(
    scope === 'following'
      ? productionTexts.keyframeNotes.followingFrames({ frame: context.args.frame })
      : productionTexts.keyframeNotes.singleFrame({ frame: context.args.frame })
  );
  await expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument();
}

export const RequiredNote: Story = {
  name: 'Обязательное замечание — пустая форма и фокус',
  play: expectCleanForm
};

export const WhitespaceNote: Story = {
  name: 'Пробелы и переносы не разрешают подтверждение',
  play: async (context) => {
    const dialog = await dialogOf(context);
    await userEvent.type(dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note }), '   {enter}   ');
    await expect(dialog.getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm })).toBeDisabled();
  }
};

export const FollowingConfirmed: Story = {
  name: 'Подтверждение — эта и следующие опоры',
  play: (context) => confirm(context, 'following')
};

export const SingleFrameConfirmed: Story = {
  name: 'Подтверждение — только эта опора',
  play: (context) => confirm(context, 'frame')
};

export const CancelAndEscape: Story = {
  name: 'Отмена и Escape — без сохранения замечания',
  play: async (context) => {
    let dialog = await dialogOf(context);
    await userEvent.type(dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note }), NOTE);
    await userEvent.click(dialog.getByRole('checkbox', { name: productionTexts.keyframeNoteScopeField.following }));
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(CANCELLED)).toBeInTheDocument();
    await expect(canvas.getByRole('status')).toHaveTextContent(EMPTY_RESULT);
    await reopen(context);
    dialog = await dialogOf(context);
    await userEvent.type(dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note }), NOTE);
    await userEvent.keyboard('{Escape}');
    await expect(await canvas.findByText(CANCELLED)).toBeInTheDocument();
    await expect(canvas.getByRole('status')).toHaveTextContent(EMPTY_RESULT);
    await expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const CleanReopen: Story = {
  name: 'Повторное открытие — чистая форма и сохранённый результат',
  play: async (context) => {
    await confirm(context, 'frame');
    await reopen(context);
    await userEvent.click((await dialogOf(context)).getByRole('button', { name: commonTexts.cancel }));
    const result = await within(context.canvasElement).findByRole('status');
    await expect(result).toHaveTextContent(NOTE);
    await expect(result).toHaveTextContent(productionTexts.keyframeNotes.singleFrame({ frame: context.args.frame }));
  }
};

export const LongFrameAndNote: Story = {
  name: 'Длинное название опоры и многострочное замечание',
  args: { frame: 'K02 — герой у старых ворот, непрерывность одежды и вечернего освещения после поездки по просёлочной дороге' },
  play: async (context) => {
    const dialog = await dialogOf(context);
    const input = dialog.getByRole('textbox', { name: productionTexts.keyframeReopenDialog.note });
    await userEvent.click(input);
    await userEvent.paste(LONG_NOTE);
    await expect(input).toHaveValue(LONG_NOTE);
    // Роль появляется до завершения Fade: проверка доступных действий ждёт видимый диалог.
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.cancel })).toBeVisible());
    await expect(dialog.getByRole('button', { name: productionTexts.keyframeReopenDialog.confirm })).toBeEnabled();
  }
};
