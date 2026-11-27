/** Свой видеопромпт: длина и предел провайдера, отказ Go, метки героев с образами; сохранённый текст остаётся только в памяти истории. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack } from '@mui/material';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { createSavedLooksModel } from '../../../testing/savedLooksStories';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';
import { ActionButton } from '../../../components/ActionButton';
import { OwnPromptDialog } from './OwnPromptDialog';

const texts = productionTexts.ownPromptDialog;
const REJECTED = 'Сначала утвердите все опоры.';
const CANCELLED = 'Окно закрыто без сохранения.';

function OwnPromptStory({ initial = '', limit = 40, rejectFirst = false }: { initial?: string; limit?: number; rejectFirst?: boolean }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [rejected, setRejected] = useState(false);
  return (
    <Stack spacing={2}>
      <Alert severity={saved ? 'success' : 'info'} role="status" data-testid="own-prompt-saved">
        {saved ?? 'Промпт ещё не сохранён.'}
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
          {productionTexts.ownDescriptionDialog.writeOwn}
        </ActionButton>
      </div>
      {open && (
        <OwnPromptDialog
          project="/story/project"
          shot="M02"
          initial={initial}
          limit={limit}
          busy={false}
          error={error}
          onClose={() => {
            setCancelled(true);
            setOpen(false);
          }}
          onSave={(prompt) => {
            if (rejectFirst && !rejected) {
              setRejected(true);
              setError(REJECTED);
              return;
            }
            setSaved(`Сохранено: ${prompt}`);
            setOpen(false);
          }}
        />
      )}
    </Stack>
  );
}

const meta = {
  title: 'Производство/Видеопромпт/Свой видеопромпт',
  component: OwnPromptStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof OwnPromptStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const dialog = (context: Context) => screenOf(context).findByRole('dialog', { name: texts.title({ shot: 'M02' }) });
const save = (context: Context) => screenOf(context).getByRole('button', { name: productionTexts.ownDescriptionDialog.save });

export const NewPrompt: Story = {
  name: 'Новый промпт · длина, предел провайдера и сохранение',
  tags: ['ci'],
  play: async (context) => {
    const screen = screenOf(context);
    const box = await dialog(context);
    await expectImplicitCloseBlocked(box);
    const body = within(box);
    await expect(save(context)).toBeDisabled();
    await userEvent.hover(save(context).parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(texts.required);
    const field = body.getByRole('textbox', { name: texts.prompt });
    await userEvent.type(field, 'Камера плавно приближается к старым воротам у дома.');
    await expect(body.getByText(texts.chars({ chars: 51, limit: 40 }))).toBeVisible();
    await userEvent.hover(save(context).parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(productionTexts.promptLimit.approveReason({ chars: 51, limit: 40 })));
    await userEvent.clear(field);
    await userEvent.type(field, 'Камера приближается к воротам.');
    await waitFor(() => expect(save(context)).toBeEnabled());
    await userEvent.click(save(context));
    await waitFor(() => expect(screen.getByTestId('own-prompt-saved')).toHaveTextContent('Сохранено: Камера приближается к воротам.'));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const Rejected: Story = {
  name: 'Отказ проверки · окно остаётся открытым с причиной',
  args: { initial: 'Камера неподвижна.', rejectFirst: true },
  play: async (context) => {
    const screen = screenOf(context);
    const body = within(await dialog(context));
    await userEvent.click(save(context));
    await expect(await body.findByText(REJECTED)).toBeVisible();
    await expect(body.getByRole('textbox', { name: texts.prompt })).toHaveValue('Камера неподвижна.');
    await userEvent.click(screen.getByRole('button', { name: commonTexts.cancel }));
    await expect(await screen.findByText(CANCELLED)).toBeVisible();
  }
};

export const NoLimit: Story = {
  name: 'Провайдер без предела · только длина',
  args: { initial: 'Камера неподвижна.', limit: 0 },
  play: async (context) => {
    const body = within(await dialog(context));
    await expect(body.getByText(texts.chars({ chars: 18, limit: 0 }))).toBeVisible();
    await expect(save(context)).toBeEnabled();
  }
};

// Герои «В кадре»: у Лодки образ есть, у Причала устарел, у Чайки нет — кнопок две, у Чайки кнопки нет.
const heroLooks = () => ({
  savedLooks: createSavedLooksModel(
    {
      looks: [
        { id: '11', name: 'Лодка' },
        { id: '12', name: 'Причал' }
      ],
      bindings: { boat: { look: '11' }, pier: { look: '12', stale: true } },
      heroes: [
        { code: 'boat', name: 'Лодка' },
        { code: 'pier', name: 'Причал' },
        { code: 'gull', name: 'Чайка' }
      ]
    },
    () => ['boat', 'pier', 'gull']
  )
});

export const HeroMarks: Story = {
  name: 'Метки героев с образами · вставка в позицию курсора',
  args: { initial: 'Лодка плывёт к причалу.', limit: 0 },
  parameters: { songframe: { createApi: heroLooks } },
  play: async (context) => {
    const body = within(await dialog(context));
    await expect(await body.findByText(savedLooksTexts.marksTitle)).toBeVisible();
    await expect(body.queryByRole('button', { name: savedLooksTexts.markLabel({ name: 'Чайка' }) })).not.toBeInTheDocument();
    const field = body.getByRole('textbox', { name: texts.prompt }) as HTMLTextAreaElement;
    await userEvent.click(field);
    field.setSelectionRange(5, 5);
    await userEvent.click(body.getByRole('button', { name: savedLooksTexts.markLabel({ name: 'Лодка' }) }));
    await waitFor(() => expect(field).toHaveValue('Лодка [@boat] плывёт к причалу.'));
    field.setSelectionRange(field.value.length - 1, field.value.length - 1);
    await userEvent.click(body.getByRole('button', { name: savedLooksTexts.markLabel({ name: 'Причал' }) }));
    await waitFor(() => expect(field).toHaveValue('Лодка [@boat] плывёт к причалу [@pier].'));
    await userEvent.click(save(context));
    await waitFor(() => expect(screenOf(context).getByTestId('own-prompt-saved')).toHaveTextContent('Сохранено: Лодка [@boat] плывёт к причалу [@pier].'));
  }
};

export const HeroMarksNone: Story = {
  name: 'Метки героев · у героев в кадре нет образов',
  args: { initial: 'Лодка плывёт.', limit: 0 },
  parameters: { songframe: { createApi: () => ({ savedLooks: createSavedLooksModel({ heroes: [{ code: 'boat', name: 'Лодка' }] }, () => ['boat']) }) } },
  play: async (context) => {
    const body = within(await dialog(context));
    await expect(await body.findByText(savedLooksTexts.marksNone)).toBeVisible();
  }
};
