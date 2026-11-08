/** Менеджер компонентов на модели window.api.components; витрина не стартует Wails. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { componentTexts as text } from '@shared/texts/component-manager';
import { ComponentsPage } from './ComponentsPage';
import { componentsStoryOptions, createComponentsModel } from '../../testing/componentsModel';

const meta = {
  title: 'Компоненты/Менеджер',
  component: ComponentsPage,
  tags: ['ci'],
  parameters: { songframe: componentsStoryOptions() }
} satisfies Meta<typeof ComponentsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const noMaintenance = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.queryByRole('button', { name: /Проверить компоненты|Перепроверить файлы|Обновить|Забыть путь|Выбрать установленное|Установить из файла/ })
  ).not.toBeInTheDocument();
  await expect(canvasElement.querySelector('details')).toBeNull();
};

export const AutomaticReady: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole('region', { name: text.names.ffmpeg }));
    await expect(await card.findByText(text.statuses.ready)).toBeVisible();
    await expect(card.queryByRole('button', { name: text.install })).not.toBeInTheDocument();
    await expect(card.queryByText(text.disk, { exact: false })).not.toBeInTheDocument();
    await expect(card.queryByText(text.temporary, { exact: false })).not.toBeInTheDocument();
    await expect(card.queryByRole('button', { name: text.chooseOnComputer })).not.toBeInTheDocument();
    await expect(card.getByText(`${text.path}: /test/Готовые компоненты/ffmpeg`)).not.toBeVisible();
    const settings = card.getByRole('button', { name: text.changeConnection });
    settings.focus();
    await userEvent.keyboard('{Enter}');
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByRole('button', { name: text.chooseOnComputer })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByLabelText(text.result)).not.toBeInTheDocument();
    await expect(canvasElement.querySelector('.MuiSnackbar-root')).toBeNull();
    await noMaintenance(canvasElement);
    await expect(canvas.getByText(text.storageHint)).not.toBeVisible();
  }
};
export const Dark: Story = { ...AutomaticReady, globals: { theme: 'dark' } };
// Backend сообщает расчётные entrypoints и при отсутствии файлов. Воспроизводим эту
// реальную форму ответа, чтобы закрытая витрина не прятала противоречивое «Расположение».
const missingPathsModel = createComponentsModel({ foundFFmpeg: false });
export const Missing: Story = {
  parameters: { songframe: componentsStoryOptions(missingPathsModel) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole('region', { name: text.names.ffmpeg }));
    await waitFor(() => expect(card.getByRole('button', { name: text.install })).toBeEnabled());
    await expect(card.getByText(text.approximateSize('1 МиБ'))).toBeVisible();
    await expect(card.queryByText(/^Версия:/)).not.toBeInTheDocument();
    await expect(card.queryByText(/^Источник:/)).not.toBeInTheDocument();
    await expect(card.queryByText(/^Путь:/)).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText(text.result)).not.toBeInTheDocument();
    const model = within(await canvas.findByRole('region', { name: text.names['ctc-ru'] }));
    await userEvent.click(model.getByRole('button', { name: text.details }));
    await expect(model.getByRole('button', { name: text.details })).toHaveAttribute('aria-expanded', 'true');
    await expect(model.queryByText(/Будущая установка/)).not.toBeInTheDocument();
    await expect(model.queryByText(/^Расположение:/)).not.toBeInTheDocument();
    await noMaintenance(canvasElement);
  }
};
export const Ready: Story = {
  parameters: { songframe: componentsStoryOptions({ status: 'ready' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await within(await canvas.findByRole('region', { name: text.names['ort-cpu'] })).findByText(text.statuses.ready)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: text.install })).not.toBeInTheDocument();
    await expect(canvas.queryByText(text.disk, { exact: false })).not.toBeInTheDocument();
    await noMaintenance(canvasElement);
  }
};
export const Downloading: Story = {
  parameters: { songframe: componentsStoryOptions({ installation: 'downloading' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('progressbar', { name: text.statuses.downloading })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: text.cancelInstall }));
    await expect(await canvas.findByText(/Отменено:/)).toBeVisible();
  }
};
export const Verifying: Story = {
  parameters: { songframe: componentsStoryOptions({ installation: 'verifying' }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('progressbar', { name: text.statuses.verifying })).toBeVisible();
  }
};
export const ErrorRecovery: Story = {
  parameters: { songframe: componentsStoryOptions({ foundFFmpeg: false, failInstallOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      card = within(await canvas.findByRole('region', { name: text.names.ffmpeg }));
    await waitFor(() => expect(card.getByRole('button', { name: text.install })).toBeEnabled());
    await userEvent.click(card.getByRole('button', { name: text.install }));
    await expect(await canvas.findByText(text.actionFailed)).toBeVisible();
    await expect(canvasElement.querySelector('.MuiSnackbar-root')).toBeNull();
    await userEvent.click(card.getByRole('button', { name: text.install }));
    await expect(await card.findByText(text.statuses.ready)).toBeVisible();
    await expect(card.queryByRole('button', { name: text.install })).not.toBeInTheDocument();
  }
};
const connectionModel = createComponentsModel();
export const ConnectOnComputer: Story = {
  parameters: { songframe: componentsStoryOptions(connectionModel) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      ort = within(await canvas.findByRole('region', { name: text.names['ort-cpu'] }));
    await waitFor(() => expect(ort.getByRole('button', { name: text.chooseOnComputer })).toBeEnabled());
    await userEvent.click(ort.getByRole('button', { name: text.chooseOnComputer }));
    await expect(await ort.findByText(text.statuses.ready)).toBeVisible();
    await expect(ort.queryByRole('button', { name: text.install })).not.toBeInTheDocument();
    await expect(ort.getByText(`${text.path}: /test/Выбранные компоненты/ort-cpu`)).not.toBeVisible();
    await userEvent.click(ort.getByRole('button', { name: text.changeConnection }));
    await expect(ort.getByText(`${text.path}: /test/Выбранные компоненты/ort-cpu`)).toBeVisible();
    const ctc = within(canvas.getByRole('region', { name: text.names['ctc-vocab'] }));
    await userEvent.click(ctc.getByRole('button', { name: text.chooseOnComputer }));
    await expect(await ctc.findByText(text.statuses.ready)).toBeVisible();
    await expect(connectionModel.counters().legacyInstalls).toBe(0);
    await noMaintenance(canvasElement);
  }
};
export const ConnectArchive: Story = {
  parameters: { songframe: componentsStoryOptions({ connectionType: 'archive' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      card = within(await canvas.findByRole('region', { name: text.names['ort-cpu'] }));
    await waitFor(() => expect(card.getByRole('button', { name: text.chooseOnComputer })).toBeEnabled());
    await userEvent.click(card.getByRole('button', { name: text.chooseOnComputer }));
    await expect(await card.findByText(text.statuses.ready)).toBeVisible();
    await noMaintenance(canvasElement);
  }
};
export const ConnectBadThenValid: Story = {
  parameters: { songframe: componentsStoryOptions({ failConnectOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      card = within(await canvas.findByRole('region', { name: text.names['ort-cpu'] }));
    await waitFor(() => expect(card.getByRole('button', { name: text.chooseOnComputer })).toBeEnabled());
    await userEvent.click(card.getByRole('button', { name: text.chooseOnComputer }));
    await expect(await canvas.findByText(text.actionFailed)).toBeVisible();
    await expect(canvas.getByText('SHA файла не совпадает: /test/Выбранный компонент/archive')).not.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: text.technicalDetails }));
    await expect(canvas.getByText('SHA файла не совпадает: /test/Выбранный компонент/archive')).toBeVisible();
    await userEvent.click(card.getByRole('button', { name: text.chooseOnComputer }));
    await expect(await card.findByText(text.statuses.ready)).toBeVisible();
    await expect(canvas.queryByText(text.actionFailed)).not.toBeInTheDocument();
  }
};
export const CancelledConnect: Story = {
  parameters: { songframe: componentsStoryOptions({ cancelConnect: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      card = within(await canvas.findByRole('region', { name: text.names['ort-cpu'] }));
    await waitFor(() => expect(card.getByRole('button', { name: text.chooseOnComputer })).toBeEnabled());
    await userEvent.click(card.getByRole('button', { name: text.chooseOnComputer }));
    await expect(canvasElement.querySelector('.MuiSnackbar-root')).toBeNull();
    await expect(canvas.queryByLabelText(text.result)).not.toBeInTheDocument();
    await expect(card.getByText(text.statuses.missing)).toBeVisible();
  }
};
const dependencyModel = createComponentsModel({ fault: 'blocked' });
export const ModelWaitsForRuntime: Story = {
  parameters: { songframe: componentsStoryOptions(dependencyModel, '/components?operation=known-text-ctc&returnTo=/project/timing') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      model = within(await canvas.findByRole('region', { name: text.names['ctc-ru'] }));
    await expect(await model.findByText(text.statuses.blocked)).toBeVisible();
    await expect(model.queryByRole('button', { name: text.install })).not.toBeInTheDocument();
    await expect(model.queryByText(text.disk, { exact: false })).not.toBeInTheDocument();
    const fragment = window.location.hash;
    await userEvent.click(model.getByRole('button', { name: text.openRequired }));
    await expect(window.location.hash).toBe(fragment);
    await expect(canvas.getByText(text.approximateSize('3 МиБ'))).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: text.installMissing }));
    await waitFor(() => expect(dependencyModel.lastRequest()).toEqual(['ort-cpu', 'voc-ft', 'ctc-vocab']));
    await waitFor(() => expect(canvas.queryByRole('region', { name: text.names['ctc-ru'] })).not.toBeInTheDocument());
  }
};
export const ComponentError: Story = {
  parameters: { songframe: componentsStoryOptions({ fault: 'ort-error' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      card = within(await canvas.findByRole('region', { name: text.names['ort-cpu'] }));
    await expect(await card.findByText(text.statuses.error)).toBeVisible();
    await expect(card.getByText(text.componentError)).toBeVisible();
    await expect(card.getByText('Не удалось загрузить ONNX Runtime: несовместимая библиотека.')).not.toBeVisible();
    await userEvent.click(card.getByRole('button', { name: text.details }));
    await expect(card.getByText('Не удалось загрузить ONNX Runtime: несовместимая библиотека.')).toBeVisible();
    await expect(canvasElement.querySelector('.MuiSnackbar-root')).toBeNull();
  }
};
export const LongPathDark: Story = {
  parameters: { songframe: componentsStoryOptions({ longPath: true }) },
  globals: { theme: 'dark' },
  play: AutomaticReady.play
};
export const CatalogRecovery: Story = {
  parameters: { songframe: componentsStoryOptions({ failCatalogOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(text.readFailed)).toBeVisible();
    await expect(await canvas.findByRole('region', { name: text.names.ffmpeg })).toBeVisible();
    await waitFor(() => expect(canvas.queryByText(text.readFailed)).not.toBeInTheDocument());
  }
};
const observed = createComponentsModel();
/** Повторное открытие и polling читают уже известную готовность без новых probes и скачиваний. */
export const PollingIsReadOnly: Story = {
  parameters: { songframe: componentsStoryOptions(observed) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await within(await canvas.findByRole('region', { name: text.names.ffmpeg })).findByText(text.statuses.ready)).toBeVisible();
    const checks = observed.counters().checks;
    const reads = observed.counters().reads;
    await waitFor(() => expect(observed.counters().reads).toBeGreaterThan(reads), { timeout: 2000 });
    await expect(observed.counters().checks).toBe(checks);
    await expect(observed.counters().manualChecks).toBe(0);
    await expect(observed.counters().installs).toBe(0);
  }
};
