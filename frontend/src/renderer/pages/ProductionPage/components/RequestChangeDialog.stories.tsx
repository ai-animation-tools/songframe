/** «Изменить» подготовленный запрос: модели и параметры из Go, сборка заново без агента, отказ и ошибка чтения. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Alert, Stack } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import type { ProductionRequestChange, ProductionRequestOptions } from '@shared/production-workflow';
import { ActionButton } from '../../../components/ActionButton';
import { createStoryApi, type StoryOptions } from '../../../testing/storybook';
import { RequestChangeDialog } from './RequestChangeDialog';

const texts = productionTexts.requestChangeDialog;
const REJECTED = 'Сервис не принял запрос: попробуйте позже.';
const SHORT = 'Модель не даёт видео длиной 7 с: доступно 5, 10 с.';

/** Текущий запрос — быстрая модель без выбираемых параметров; вторая модель выбирает звук и качество; третья плану не подходит. */
const OPTIONS: ProductionRequestOptions = {
  models: [
    { id: 'test-video-short', parameters: [], unavailable: SHORT },
    { id: 'test-video-fast', parameters: [] },
    {
      id: 'test-video-pro',
      parameters: [
        { name: 'enable_audio', values: [false, true] },
        { name: 'quality', values: ['standard', 'high'] }
      ]
    }
  ],
  model: 'test-video-fast',
  parameters: {},
  marked: false
};

function RequestChangeStory({ rejectFirst = false }: { rejectFirst?: boolean }) {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<ProductionRequestChange | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  return (
    <Stack spacing={2}>
      <Alert severity={saved ? 'success' : 'info'} role="status" data-testid="request-change-saved">
        {saved ? `${saved.model} ${JSON.stringify(saved.parameters)}` : 'Запрос не изменён.'}
      </Alert>
      {rejected ? <Alert severity="error">{rejected}</Alert> : null}
      <div>
        <ActionButton startIcon={<EditIcon />} onClick={() => setOpen(true)}>
          {texts.open}
        </ActionButton>
      </div>
      {open ? (
        <RequestChangeDialog
          project="/mock/Клип"
          shot="M02"
          packageDir="/mock/Клип/plan/batches/M02-attempt-01"
          provider="test"
          busy={false}
          onClose={() => setOpen(false)}
          onConfirm={async (change) => {
            // Как ошибка Go: окно остаётся открытым с выбором, причина видна на странице.
            if (rejectFirst && !rejected) {
              setRejected(REJECTED);
              return false;
            }
            setSaved(change);
            return true;
          }}
        />
      ) : null}
    </Stack>
  );
}

const options = (requestOptions: () => Promise<ProductionRequestOptions>): StoryOptions => ({
  createApi: () => createStoryApi({ productionWorkflow: { requestOptions } })
});

const meta = {
  title: 'Производство/Запрос/Изменить запрос',
  component: RequestChangeStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true }, songframe: options(async () => structuredClone(OPTIONS)) }
} satisfies Meta<typeof RequestChangeStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const dialog = async (context: Context) => within(await screenOf(context).findByRole('dialog', { name: texts.title({ shot: 'M02' }) }));
const choose = async (context: Context, field: HTMLElement, option: string): Promise<void> => {
  await userEvent.click(field);
  await userEvent.click(await screenOf(context).findByRole('option', { name: option }));
};

export const Change: Story = {
  tags: ['ci'],
  name: 'Другая модель · параметры по её объявлениям, неподходящая выключена с причиной',
  play: async (context) => {
    const view = await dialog(context);
    const model = await view.findByRole('combobox', { name: texts.model });
    await expect(model).toHaveTextContent('test-video-fast');
    await expect(view.getByText(texts.noParameters)).toBeInTheDocument();
    await expect(view.getByRole('button', { name: texts.confirm })).toBeDisabled();
    // Неподходящая модель — в конце списка, выключена и объясняет причину.
    await userEvent.click(model);
    const options = await screenOf(context).findAllByRole('option');
    await expect(options.map((option) => option.textContent)).toEqual(['test-video-fast', 'test-video-pro', `test-video-short${SHORT}`]);
    await expect(options[2]).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await choose(context, model, 'test-video-pro');
    // Новая модель получает первые объявленные значения: изменение уже есть.
    await expect(await view.findByRole('combobox', { name: 'enable_audio' })).toHaveTextContent(texts.no);
    await expect(view.getByRole('combobox', { name: 'quality' })).toHaveTextContent('standard');
    await choose(context, view.getByRole('combobox', { name: 'quality' }), 'high');
    await userEvent.click(view.getByRole('button', { name: texts.confirm }));
    await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screenOf(context).getByTestId('request-change-saved')).toHaveTextContent('test-video-pro {"enable_audio":false,"quality":"high"}');
  }
};

export const Rejected: Story = {
  name: 'Отказ сборки · окно и выбор остаются',
  args: { rejectFirst: true },
  play: async (context) => {
    const view = await dialog(context);
    await choose(context, await view.findByRole('combobox', { name: texts.model }), 'test-video-pro');
    await userEvent.click(view.getByRole('button', { name: texts.confirm }));
    await expect(await screenOf(context).findByText(REJECTED)).toBeInTheDocument();
    await expect(view.getByRole('combobox', { name: texts.model })).toHaveTextContent('test-video-pro');
    await userEvent.click(view.getByRole('button', { name: texts.confirm }));
    await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screenOf(context).getByTestId('request-change-saved')).toHaveTextContent('test-video-pro');
  }
};

export const CurrentUnavailable: Story = {
  name: 'Текущая модель больше не подходит · причина у поля, сборка недоступна',
  parameters: {
    songframe: options(async () => ({
      ...structuredClone(OPTIONS),
      models: OPTIONS.models.map((model) => (model.id === 'test-video-fast' ? { ...model, unavailable: SHORT } : model)),
      model: 'test-video-fast'
    }))
  },
  play: async (context) => {
    const view = await dialog(context);
    await expect(await view.findByRole('combobox', { name: texts.model })).toHaveTextContent('test-video-fast');
    await expect(view.getAllByText(SHORT).length).toBeGreaterThan(0);
    await expect(view.getByRole('button', { name: texts.confirm })).toBeDisabled();
    await choose(context, view.getByRole('combobox', { name: texts.model }), 'test-video-pro');
    await expect(view.getByRole('button', { name: texts.confirm })).toBeEnabled();
  }
};

const LOOKS = 'Модель test-video-fast не принимает сохранённые образы: облик по образу не получат Лодка, Причал.';

export const SavedLooks: Story = {
  tags: ['ci'],
  name: 'Метки героев · модель без образов предупреждает, кто потеряет облик; запрос собирается заново без изменений',
  parameters: {
    songframe: options(async () => ({
      ...structuredClone(OPTIONS),
      models: OPTIONS.models.map((model) => (model.id === 'test-video-fast' ? { ...model, looks: LOOKS } : model)),
      marked: true
    }))
  },
  play: async (context) => {
    const view = await dialog(context);
    await expect(await view.findByRole('combobox', { name: texts.model })).toHaveTextContent('test-video-fast');
    await expect(view.getByText(LOOKS)).toBeVisible();
    // Те же модель и параметры: запрос можно собрать заново, чтобы он получил образы, привязанные после сборки.
    await expect(view.getByRole('button', { name: texts.confirm })).toBeEnabled();
    await choose(context, view.getByRole('combobox', { name: texts.model }), 'test-video-pro');
    await expect(view.queryByText(LOOKS)).not.toBeInTheDocument();
  }
};

export const LoadFailed: Story = {
  name: 'Модели не прочитаны · причина и только отмена',
  parameters: {
    songframe: options(async () => {
      throw new Error('Провайдер видео не ответил: проверьте подключение.');
    })
  },
  play: async (context) => {
    const view = await dialog(context);
    await expect(await view.findByText(/Провайдер видео не ответил/)).toBeInTheDocument();
    await expect(view.getByRole('button', { name: texts.confirm })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screenOf(context).queryByRole('dialog')).not.toBeInTheDocument());
  }
};
