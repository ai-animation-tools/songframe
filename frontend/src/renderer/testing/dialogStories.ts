/** Проверяет оба случайных способа закрытия на настоящем MUI Dialog, включая клик вне Paper. */
import { expect, userEvent } from 'storybook/test';

export async function expectImplicitCloseBlocked(dialog: HTMLElement, verify?: () => Promise<void>): Promise<void> {
  dialog.focus();
  await userEvent.keyboard('{Escape}');
  // Закрывающий Fade занимает 200 мс: проверка после него выявляет и асинхронное размонтирование.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await expect(dialog).toBeVisible();
  await verify?.();
  // MUI ловит backdropClick на контейнере вокруг Paper: клик по его фону воспроизводит штатный путь.
  await userEvent.click(dialog.parentElement!);
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await expect(dialog).toBeVisible();
  await verify?.();
}
