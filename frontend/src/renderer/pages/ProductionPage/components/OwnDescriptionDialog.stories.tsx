/** Своё описание плана: проверки черновика, план опор и референсы; сохранённый текст остаётся только в памяти истории. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack, Typography } from '@mui/material';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';
import { createStoryApi, type StoryOptions } from '../../../testing/storybook';
import { ActionButton } from '../../../components/ActionButton';
import { initialDraft, ownText, type OwnDescriptionDraft } from '../ownDescription';
import { OwnDescriptionDialog } from './OwnDescriptionDialog';

const texts = productionTexts.ownDescriptionDialog;
const PROJECT = '/mock/Клип у старых ворот';
const REFERENCES = ['source/heroes/story-image.png', 'source/places/story-image.png'];
const REJECTED = 'Опора K02 должна стоять строго между соседними опорами.';
const CANCELLED = 'Окно закрыто без сохранения.';

interface OwnStoryProps {
  manual?: boolean;
  limit?: number;
  /** Первое сохранение отклоняется Go: окно остаётся открытым с причиной. */
  rejectFirst?: boolean;
  initial?: OwnDescriptionDraft;
}

function OwnDescriptionStory({ manual = false, limit = 4, rejectFirst = false, initial }: OwnStoryProps) {
  const start = initial ?? initialDraft({ description: null, requestSeconds: null, framePrompts: [], window: 5.5, manual });
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [rejected, setRejected] = useState(false);
  return (
    <Stack spacing={2}>
      <Alert severity={saved ? 'success' : 'info'} role="status" data-testid="own-saved">
        {saved ?? 'Описание ещё не сохранено.'}
      </Alert>
      {cancelled && <Alert severity="info">{CANCELLED}</Alert>}
      <div>
        <ActionButton
          startIcon={<EditNoteIcon />}
          onClick={() => {
            setCancelled(false);
            setError(null);
            setOpen(true);
          }}
        >
          {texts.writeOwn}
        </ActionButton>
      </div>
      {open && (
        <OwnDescriptionDialog
          project={PROJECT}
          shot="M02"
          windowSeconds={5.5}
          initial={start}
          limit={limit}
          manual={manual}
          busy={false}
          error={error}
          onClose={() => {
            setCancelled(true);
            setOpen(false);
          }}
          onSave={(draft) => {
            if (rejectFirst && !rejected) {
              setRejected(true);
              setError(REJECTED);
              return;
            }
            const text = ownText(draft);
            setSaved(
              `${text.description} | ${text.requestSeconds} с | ${text.keyframes.map((frame) => `${frame.id}/${frame.role}/${frame.timeSeconds}/${frame.referencePaths.length}`).join(', ')}`
            );
            setOpen(false);
          }}
        />
      )}
      <Typography variant="caption" color="text.secondary">
        Окно плана 5,5 с; длительность запроса по умолчанию — 6 с.
      </Typography>
    </Stack>
  );
}

const options = (): StoryOptions => ({ createApi: () => createStoryApi({ productionWorkflow: { referenceImages: async () => [...REFERENCES] } }) });

const meta = {
  title: 'Производство/Описание/Своё описание',
  component: OwnDescriptionStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true }, songframe: options() }
} satisfies Meta<typeof OwnDescriptionStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const dialog = (context: Context) => screenOf(context).findByRole('dialog', { name: texts.title({ shot: 'M02' }) });
const save = (context: Context) => screenOf(context).getByRole('button', { name: texts.save });

export const NewDescription: Story = {
  name: 'Новое описание · проверки, промежуточная опора и референсы',
  tags: ['ci'],
  play: async (context) => {
    const screen = screenOf(context);
    const body = within(await dialog(context));
    await expectImplicitCloseBlocked(await dialog(context));
    // Пустой черновик: две опоры, длительность — наименьшее целое больше окна.
    await expect(body.getByLabelText(texts.requestSeconds)).toHaveValue(6);
    await expect(body.getByText(texts.frameTitle({ id: 'K01', role: 'first' }))).toBeVisible();
    await expect(body.getByText(texts.frameTitle({ id: 'K02', role: 'last' }))).toBeVisible();
    await expect(save(context)).toBeDisabled();
    await userEvent.hover(save(context).parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(texts.descriptionRequired);
    await userEvent.type(body.getByLabelText(texts.description), 'Герой идёт к воротам.');
    const prompts = body.getAllByLabelText(texts.prompt);
    await userEvent.type(prompts[0], 'Герой у машины.');
    await userEvent.type(prompts[1], 'Герой у ворот.');
    await waitFor(() => expect(save(context)).toBeEnabled());
    // Промежуточная опора встаёт перед последней посередине запроса; последняя получает новый ID.
    await userEvent.click(body.getByRole('button', { name: texts.addFrame }));
    await expect(body.getByText(texts.frameTitle({ id: 'K02', role: 'middle' }))).toBeVisible();
    await expect(body.getByText(texts.frameTitle({ id: 'K03', role: 'last' }))).toBeVisible();
    await expect(body.getByLabelText(texts.time)).toHaveValue(3);
    await expect(save(context)).toBeDisabled();
    await userEvent.type(body.getAllByLabelText(texts.prompt)[1], 'Герой поворачивается к окну.');
    await userEvent.clear(body.getByLabelText(texts.time));
    await userEvent.type(body.getByLabelText(texts.time), '7');
    await userEvent.hover(save(context).parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(texts.frameTimeInvalid({ id: 'K02' })));
    await userEvent.clear(body.getByLabelText(texts.time));
    await userEvent.type(body.getByLabelText(texts.time), '2.5');
    // Референс выбирается из изображений проекта и сразу показан миниатюрой.
    await userEvent.click(body.getAllByLabelText(texts.references)[0]);
    await userEvent.click(await screen.findByRole('option', { name: REFERENCES[0] }));
    // Выбранный путь показан и в поле, и миниатюрой, которая открывает просмотр.
    await expect(body.getAllByRole('button', { name: /story-image\.png/ })).toHaveLength(2);
    await userEvent.click(save(context));
    await waitFor(() =>
      expect(screen.getByTestId('own-saved')).toHaveTextContent('Герой идёт к воротам. | 6 с | K01/first/0/1, K02/middle/2.5/0, K03/last/6/0')
    );
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const Rejected: Story = {
  name: 'Отказ проверки · окно остаётся открытым с причиной',
  args: {
    rejectFirst: true,
    initial: {
      description: 'Герой идёт к воротам.',
      requestSeconds: '6',
      frames: [
        { time: '', prompt: 'Начало', referencePaths: [] },
        { time: '', prompt: 'Конец', referencePaths: [] }
      ]
    }
  },
  play: async (context) => {
    const screen = screenOf(context);
    const body = within(await dialog(context));
    await userEvent.click(save(context));
    await expect(await body.findByText(REJECTED)).toBeVisible();
    await expect(body.getByLabelText(texts.description)).toHaveValue('Герой идёт к воротам.');
    await userEvent.click(save(context));
    await waitFor(() => expect(screen.getByTestId('own-saved')).toHaveTextContent('K01/first/0/0, K02/last/6/0'));
  }
};

export const ManualSingle: Story = {
  name: 'Речевой план ручной генерации · одна опора',
  args: { manual: true },
  play: async (context) => {
    const body = within(await dialog(context));
    await expect(body.getByText(texts.manualSingle)).toBeVisible();
    await expect(body.getByText(texts.frameTitle({ id: 'K01', role: 'first' }))).toBeVisible();
    await expect(body.queryByRole('button', { name: texts.addFrame })).not.toBeInTheDocument();
    await expect(body.queryByRole('button', { name: texts.removeFrame({ id: 'K01' }) })).not.toBeInTheDocument();
  }
};

export const Limit: Story = {
  name: 'Предел провайдера · добавить опору нельзя',
  args: { limit: 2 },
  play: async (context) => {
    const screen = screenOf(context);
    const body = within(await dialog(context));
    const add = body.getByRole('button', { name: texts.addFrame });
    await expect(add).toBeDisabled();
    await userEvent.hover(add.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(texts.limit({ limit: 2 }));
    // Удаление конца оставляет одну опору — начало плана.
    await userEvent.click(body.getByRole('button', { name: texts.removeFrame({ id: 'K02' }) }));
    await expect(body.getByText(texts.frameTitle({ id: 'K01', role: 'first' }))).toBeVisible();
    await expect(body.queryByText(texts.frameTitle({ id: 'K02', role: 'last' }))).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: commonTexts.cancel }));
    await expect(await screen.findByText(CANCELLED)).toBeVisible();
  }
};
