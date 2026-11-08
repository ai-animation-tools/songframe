/** Один сценарий сохранности черновика применяется к изолированному окну и к настоящей странице-владельцу. */
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { projectTexts } from '@shared/texts/project';
import { componentsTexts } from '@shared/texts/components';
import { DRAFT_NAME } from './dialogDraftStories';
import { expectImplicitCloseBlocked } from './dialogStories';

export async function checkDraftDialog(canvasElement: HTMLElement, kind: 'rename' | 'retry', openLabel = 'Открыть редактор'): Promise<void> {
  const canvas = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await canvas.findByRole('button', { name: openLabel }));
  let element = await screen.findByRole('dialog');
  let dialog = within(element);
  const label = kind === 'rename' ? projectTexts.rename.name : componentsTexts.agentRetry.prompt;
  const draft = kind === 'rename' ? 'Новое название клипа' : 'Сохранить одежду героя и положение камеры.';
  await userEvent.clear(dialog.getByRole('textbox', { name: label }));
  await userEvent.type(dialog.getByRole('textbox', { name: label }), draft);
  if (kind === 'retry') await userEvent.type(dialog.getByRole('textbox', { name: componentsTexts.agentRetry.context }), 'Контекст предыдущей попытки.');
  await expectImplicitCloseBlocked(element);
  await expect(dialog.getByRole('textbox', { name: label })).toHaveValue(draft);
  if (kind === 'retry') await expect(dialog.getByRole('textbox', { name: componentsTexts.agentRetry.context })).toHaveValue('Контекст предыдущей попытки.');
  // Ошибка записи или запуска также оставляет форму доступной для исправления и повтора.
  await userEvent.click(dialog.getByRole('button', { name: kind === 'rename' ? commonTexts.save : commonTexts.run }));
  await dialog.findByRole('alert');
  await expect(dialog.getByRole('textbox', { name: label })).toHaveValue(draft);
  await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await userEvent.click(canvas.getByRole('button', { name: openLabel }));
  element = await screen.findByRole('dialog');
  dialog = within(element);
  await expect(dialog.getByRole('textbox', { name: label })).toHaveValue(kind === 'rename' ? DRAFT_NAME : '');
  if (kind === 'retry') await expect(dialog.getByRole('textbox', { name: componentsTexts.agentRetry.context })).toHaveValue('');
  // Нетронутая форма закрывается клавиатурой: защита не превращает любой просмотр в ловушку.
  element.focus();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}
