/** Проверки приёмки используют рабочий диалог и отделяют запуск от завершения задания. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
import { expectImplicitCloseBlocked } from '../../../testing/dialogStories';
import { AcceptResultStory } from '../../../testing/acceptResultStories';

const meta = {
  title: 'Производство/Пакет/Приёмка результата',
  component: AcceptResultStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <AcceptResultStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof AcceptResultStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const texts = productionTexts.acceptResultDialog;
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(canvas.getByRole('button', { name: 'Открыть приёмку' }));
  const element = await screen.findByRole('dialog');
  // Ждём окончания MUI-перехода, чтобы повторное открытие проверяло новый диалог.
  await waitFor(() => expect(element).toBeVisible());
  return within(element);
}
async function closed(canvasElement: HTMLElement): Promise<void> {
  await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).not.toBeInTheDocument());
}
async function done(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await canvas.findByText('Задание приёмки: done.', {}, { timeout: 4000 });
  await expect(canvas.getByText('Принятый комплект: новый результат.')).toBeInTheDocument();
}

export const CutDefault: Story = {
  name: 'Новый комплект · длинный оригинал обрезается до окна',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(5);
    await expect(dialog.getByRole('spinbutton', { name: texts.holdLast })).toHaveValue(0);
    await expect(dialog.getByText(texts.cutFrame({ frame: 150 }))).toBeInTheDocument();
    await expect(dialog.getByText(/Оригинал длиной 8,00 с/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('combobox', { name: texts.section }));
    const screen = within(canvasElement.ownerDocument.body);
    await expect(screen.getByRole('option', { name: texts.full })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"expectedResultToken":"' + 'c'.repeat(64) + '"');
  }
};
export const CutResult: Story = {
  tags: ['ci'],
  name: 'Итог участка · длина в плане против окна при скорости и удержании',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const result = (): HTMLElement => dialog.getByTestId('accept-cut-result');
    const speed = dialog.getByRole('textbox', { name: texts.speed });
    const hold = dialog.getByRole('spinbutton', { name: texts.holdLast });
    // Участок 0–5 с при 30 к/с — 150 кадров, ровно окно.
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    // Ускорение: 150 / 1,153 = 130,1 → 130 кадров, до окна не хватает 20.
    await userEvent.clear(speed);
    await userEvent.type(speed, '1,153');
    await expect(result()).toHaveTextContent(texts.cutResultShort({ frames: 130, window: 150, missing: 20 }));
    await userEvent.clear(hold);
    await userEvent.type(hold, '20');
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    // Замедление: 150 / 0,8 = 187,5 → 188 кадров и 20 удержания — лишних 58.
    await userEvent.clear(speed);
    await userEvent.type(speed, '0,8');
    await expect(result()).toHaveTextContent(texts.cutResultLong({ frames: 208, window: 150, extra: 58 }));
    await userEvent.clear(speed);
    await userEvent.type(speed, '0');
    await expect(result()).toHaveTextContent(texts.cutResultInvalid);
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
  }
};
export const HoldFirstFitEnd: Story = {
  tags: ['ci'],
  name: 'Удержание первого кадра · конец участка подгоняется под окно',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const result = (): HTMLElement => dialog.getByTestId('accept-cut-result');
    const speed = dialog.getByRole('textbox', { name: texts.speed });
    const first = dialog.getByRole('spinbutton', { name: texts.holdFirst });
    // Кнопку ищем заново: с причиной недоступности ActionButton монтирует её внутри подсказки.
    const fit = (): HTMLElement => dialog.getByRole('button', { name: texts.fitEnd });
    await expect(first).toHaveValue(0);
    // Замедление 0,8 и 30 кадров удержания первого: 120 кадров движения — отрезок 96 кадров, конец 3,2 с.
    await userEvent.clear(speed);
    await userEvent.type(speed, '0,8');
    await userEvent.clear(first);
    await userEvent.type(first, '30');
    await expect(result()).toHaveTextContent(texts.cutResultLong({ frames: 218, window: 150, extra: 68 }));
    await userEvent.click(fit());
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(3.2);
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    // Ускорение 2 без удержания: нужен конец 10 с, а оригинал 8 с — кнопка объясняет причину.
    await userEvent.clear(first);
    await userEvent.type(first, '0');
    await userEvent.clear(speed);
    await userEvent.type(speed, '2');
    await expect(fit()).toBeDisabled();
    await expect(fit()).toHaveAttribute('title', expect.stringContaining(texts.fitEndOriginal({ needed: '10,00', original: '8,00' })));
    // Удержание на всё окно: подгонять нечего.
    await userEvent.clear(first);
    await userEvent.type(first, '150');
    await expect(fit()).toHaveAttribute('title', expect.stringContaining(texts.fitEndHolds));
    await userEvent.clear(first);
    await userEvent.type(first, '30');
    await userEvent.clear(speed);
    await userEvent.type(speed, '0,8');
    await userEvent.click(fit());
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    const submitted = within(canvasElement).getByText(/Переданные параметры:/);
    await expect(submitted).toHaveTextContent('"holdFirst":30');
    await expect(submitted).toHaveTextContent('"cutEnd":3.2');
  }
};
export const SpeedParts: Story = {
  tags: ['ci'],
  name: 'Скорость по частям · медленное начало, подгонка конца, добавить и убрать часть',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const result = (): HTMLElement => dialog.getByTestId('accept-cut-result');
    const fit = (): HTMLElement => dialog.getByRole('button', { name: texts.fitEnd });
    await userEvent.click(dialog.getByRole('switch', { name: texts.speedParts }));
    // Включение делит участок 0–5 с пополам с прежней скоростью: одна общая скорость уходит.
    await expect(dialog.queryByRole('textbox', { name: texts.speed })).not.toBeInTheDocument();
    const firstEnd = dialog.getByRole('spinbutton', { name: texts.partEnd({ index: 1 }) });
    await expect(firstEnd).toHaveValue(2.5);
    await expect(dialog.getByText(texts.partLast({ end: '5' }))).toBeInTheDocument();
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    // Первая секунда вдвое медленнее: 60 кадров, остальное 4 с — 120, всего 180 при окне 150.
    await userEvent.clear(firstEnd);
    await userEvent.type(firstEnd, '1');
    const firstSpeed = dialog.getByRole('textbox', { name: texts.partSpeed({ index: 1 }) });
    await userEvent.clear(firstSpeed);
    await userEvent.type(firstSpeed, '0,5');
    await expect(result()).toHaveTextContent(texts.cutResultLong({ frames: 180, window: 150, extra: 30 }));
    // Подгонка двигает конец последней части: окну остаётся 90 кадров после 60 медленных.
    await userEvent.click(fit());
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(4);
    await expect(dialog.getByText(texts.partLast({ end: '4' }))).toBeInTheDocument();
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    // Новая часть делит последнюю пополам, итог прежний; убранная отдаёт отрезок следующей.
    await userEvent.click(dialog.getByRole('button', { name: texts.addPart }));
    await expect(dialog.getByRole('spinbutton', { name: texts.partEnd({ index: 2 }) })).toHaveValue(2.5);
    await expect(result()).toHaveTextContent(texts.cutResultFit({ frames: 150, seconds: '5,00' }));
    await userEvent.click(dialog.getByRole('button', { name: texts.removePart({ index: 2 }) }));
    await expect(dialog.queryByRole('spinbutton', { name: texts.partEnd({ index: 2 }) })).not.toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: texts.removePart({ index: 1 }) })).toBeDisabled();
    // Части уходят в приёмку вместо общей скорости.
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    const submitted = within(canvasElement).getByText(/Переданные параметры:/);
    await expect(submitted).toHaveTextContent('"speedParts":[{"end":1,"speed":"0.5"},{"end":4,"speed":"1"}]');
    // Общей скорости нет: «speed» встречается только внутри частей.
    await expect(submitted).not.toHaveTextContent(/"speed":"[^"]*",/);
  }
};

export const CutPreviewWithLines: Story = {
  tags: ['ci'],
  name: 'Предпросмотр участка · под песню со строками, правка участка делает показ прежним',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    // Кнопку ищем заново: с причиной недоступности ActionButton монтирует её внутри подсказки.
    const show = (): HTMLElement => dialog.getByRole('button', { name: texts.preview });
    // Участок длиннее окна не собирается: кнопка называет причину.
    await userEvent.clear(dialog.getByRole('textbox', { name: texts.speed }));
    await userEvent.type(dialog.getByRole('textbox', { name: texts.speed }), '0,8');
    await expect(show()).toBeDisabled();
    await expect(show()).toHaveAttribute('title', expect.stringContaining(texts.previewMismatch));
    await userEvent.clear(dialog.getByRole('textbox', { name: texts.speed }));
    await userEvent.type(dialog.getByRole('textbox', { name: texts.speed }), '1');
    await userEvent.click(show());
    const preview = await dialog.findByTestId('cut-preview');
    await expect(within(preview).getByLabelText(texts.previewLabel)).toBeInTheDocument();
    const lines = within(preview).getAllByRole('listitem');
    await expect(lines).toHaveLength(2);
    await expect(lines[1]).toHaveAttribute('title', texts.previewLine({ text: 'И лодка ушла к маяку', start: '3,10' }));
    await expect(within(canvasElement).getByText(/Параметры предпросмотра:/)).toHaveTextContent('"cutEnd":5');
    // Правка участка после показа: ролик прежний, панель об этом говорит.
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.holdFirst }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.holdFirst }), '3');
    await expect(within(preview).getByText(texts.previewStale)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.cutPreview: 1.')).toBeInTheDocument();
  }
};
export const CutPreviewNoLines: Story = {
  name: 'Предпросмотр участка · без строк песни называет причину',
  args: { previewLines: [], lyricProblem: 'Разметки песни нет: сначала разметьте строки на странице «Тайминги».' },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: texts.preview }));
    const preview = await dialog.findByTestId('cut-preview');
    await expect(within(preview).getByText(/Разметки песни нет/)).toBeInTheDocument();
    await expect(within(preview).queryByRole('listitem')).not.toBeInTheDocument();
  }
};
export const FullDuration: Story = {
  name: 'Длительности совпали · принять оригинал целиком',
  args: { windowFrames: 240 },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('combobox', { name: texts.section })).toHaveTextContent(texts.full);
    await expect(dialog.queryByRole('spinbutton')).not.toBeInTheDocument();
    await expect(dialog.queryByTestId('accept-cut-result')).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
  }
};
export const OwnVideoFrame: Story = {
  tags: ['ci'],
  name: 'Своё видео другого кадра и частоты · только участок, приведение к кадру проекта',
  args: { media: { seconds: 4, width: 1080, height: 1920, frameRate: '30000/1001' } },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByText(texts.frameMismatch({ width: 1080, height: 1920, rate: '29,97', fps: 30 }))).toBeInTheDocument();
    // Длина взята из видео: 4 с при окне 5 с — участок до конца видео и удержание последнего кадра.
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(4);
    await expect(dialog.getByRole('spinbutton', { name: texts.holdLast })).toHaveValue(30);
    await userEvent.click(dialog.getByRole('combobox', { name: texts.section }));
    await expect(within(canvasElement.ownerDocument.body).getByRole('option', { name: texts.full })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"holdLast":30');
  }
};
export const HoldLast: Story = {
  name: 'Оригинал короче окна · удержать последний кадр',
  args: { windowFrames: 300 },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(8);
    await expect(dialog.getByRole('spinbutton', { name: texts.holdLast })).toHaveValue(60);
    await expect(dialog.getByText(/с удержанием последнего кадра/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"holdLast":60');
  }
};
export const ReplacementCancel: Story = {
  tags: ['ci'],
  name: 'Замена · отмена сохраняет комплект и сбрасывает согласие',
  args: { hasAsset: true },
  play: async ({ canvasElement }) => {
    let dialog = await open(canvasElement);
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeEnabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: texts.replace })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const ReplacementConfirm: Story = {
  tags: ['ci'],
  name: 'Замена подтверждена · прежний комплект сохранён отдельно',
  args: { hasAsset: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Прежний комплект сохранён в assets/replaced/M02.')).toBeInTheDocument();
    await expect(canvas.getByText(/Переданные параметры:/)).toHaveTextContent('"replaceExisting":true');
  }
};
export const MissingToken: Story = {
  name: 'Результат без токена · приёмка заблокирована',
  args: { missingToken: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const confirm = dialog.getByRole('button', { name: texts.accept });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', texts.resultUnconfirmed);
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const SpeechMissing: Story = {
  name: 'Речевой план без WAV · приёмка заблокирована',
  args: { speechMissing: true },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const confirm = dialog.getByRole('button', { name: texts.accept });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', texts.speechRequired);
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const CancelEscape: Story = {
  name: 'Escape сохраняет границы и скорость · запятая в скорости · явная отмена сбрасывает их',
  play: async ({ canvasElement }) => {
    let dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutStart }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutStart }), '1');
    await userEvent.clear(dialog.getByRole('textbox', { name: texts.speed }));
    // Дробь с запятой поле записывает с точкой, как её разбирает Go.
    await userEvent.type(dialog.getByRole('textbox', { name: texts.speed }), '0,8');
    await expectImplicitCloseBlocked(within(canvasElement.ownerDocument.body).getByRole('dialog'));
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(1);
    await expect(dialog.getByRole('textbox', { name: texts.speed })).toHaveValue('0.8');
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('textbox', { name: texts.speed })).toHaveValue('1');
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await closed(canvasElement);
    await expect(within(canvasElement).getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};
export const ResultChanged: Story = {
  name: 'Результат изменился · обновление и новое подтверждение',
  args: { changedAfterOpen: true, hasAsset: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Результат изменился. Обновите пакет и просмотрите его перед приёмкой.');
    await closed(canvasElement);
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Обновить пакет и просмотреть результат' }));
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    await expect(canvas.getByText(/Переданные параметры:/)).toHaveTextContent('"expectedResultToken":"' + 'e'.repeat(64) + '"');
  }
};
export const FailureRetry: Story = {
  name: 'Ошибка задания · старый комплект и оригинал сохраняются до повтора',
  args: { failFirst: true, hasAsset: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Задание приёмки: failed.', {}, { timeout: 4000 });
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await expect(canvas.getByText('Оригинал попытки сохранён.')).toBeInTheDocument();
    await closed(canvasElement);
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.click(dialog.getByRole('button', { name: texts.replace }));
    await done(canvasElement);
    await expect(canvas.getByText('Вызовы production.accept: 2.')).toBeInTheDocument();
  }
};
export const InvalidCut: Story = {
  name: 'Неверные границы · отказ до задания и исправленный повтор',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutEnd }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutEnd }), '0');
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await canvas.findByText('Конец участка должен быть позже начала.');
    await closed(canvasElement);
    await expect(canvas.queryByText(/Задание приёмки:/)).not.toBeInTheDocument();
    await expect(canvas.queryByText('Принятый комплект: новый результат.')).not.toBeInTheDocument();
    dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutStart }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutStart }), '0.01');
    await expect(dialog.getByText(texts.cutBetween({ before: '0', after: '0,033' }))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await canvas.findByText(productionTexts.main.package.acceptBoundsInvalid({ fps: 30 }));
    await closed(canvasElement);
    await expect(canvas.queryByText(/Задание приёмки:/)).not.toBeInTheDocument();
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(dialog.getByRole('spinbutton', { name: texts.cutEnd })).toHaveValue(5);
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
  }
};
export const ThousandthsCut: Story = {
  tags: ['ci'],
  name: 'Участок с начала · секунды кадра до тысячных',
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement);
    const start = dialog.getByRole('spinbutton', { name: texts.cutStart });
    const end = dialog.getByRole('spinbutton', { name: texts.cutEnd });
    // 0,875 с — между кадрами 26 и 27: подсказка называет ближайшие границы.
    await userEvent.clear(start);
    await userEvent.type(start, '0.875');
    await expect(dialog.getByText(texts.cutBetween({ before: '0,867', after: '0,9' }))).toBeInTheDocument();
    // Кадр 25 — 0,833 с, конец 5,833 с — кадр 175: окно 150 кадров со сдвигом от начала.
    await userEvent.clear(start);
    await userEvent.type(start, '0.833');
    await expect(dialog.getByText(texts.cutFrame({ frame: 25 }))).toBeInTheDocument();
    await userEvent.clear(end);
    await userEvent.type(end, '5.833');
    await expect(dialog.getByText(texts.cutFrame({ frame: 175 }))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.accept }));
    await done(canvasElement);
    await expect(within(canvasElement).getByText(/Переданные параметры:/)).toHaveTextContent('"cutStart":0.833');
  }
};
export const Running: Story = {
  name: 'Задание выполняется · комплект ещё прежний, повторный запуск закрыт',
  args: { hasAsset: true, delay: 1600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await userEvent.dblClick(dialog.getByRole('button', { name: texts.replace }));
    await canvas.findByText('Задание приёмки: running.');
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await closed(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Открыть приёмку' })).toBeDisabled();
    await expect(canvas.getByText('Вызовы production.accept: 1.')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.queryByText('Задание приёмки: running.')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await expect(canvas.getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await expect(canvas.getByText('Вызовы production.accept: 0.')).toBeInTheDocument();
  }
};

export const PreserveCutDraft: Story = {
  name: 'Срез и согласие · Escape и фон сохраняют параметры',
  tags: ['ci'],
  args: { hasAsset: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = await open(canvasElement);
    await userEvent.clear(dialog.getByRole('spinbutton', { name: texts.cutStart }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: texts.cutStart }), '1');
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.replaceCheckbox }));
    await expectImplicitCloseBlocked(screen.getByRole('dialog'));
    await expect(dialog.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(1);
    await expect(dialog.getByRole('checkbox', { name: texts.replaceCheckbox })).toBeChecked();
    await expect(within(canvasElement).getByText('Принятый комплект: прежний результат.')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await closed(canvasElement);
    const reopened = await open(canvasElement);
    await expect(reopened.getByRole('spinbutton', { name: texts.cutStart })).toHaveValue(0);
    await expect(reopened.getByRole('checkbox', { name: texts.replaceCheckbox })).not.toBeChecked();
  }
};
