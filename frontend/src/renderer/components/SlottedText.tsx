import { Fragment, type ReactElement, type ReactNode } from 'react';

/** Подставляет именованные элементы в целую фразу без HTML; отсутствующий слот остаётся видимым для исправления текста.
 * Общий для инструкций настроек и фраз производства со ссылками; правила — @link ../../../../docs/ui/texts.md.
 */
export function SlottedText({ text, slots }: { text: string; slots: Readonly<Record<string, ReactNode>> }): ReactElement {
  return (
    <>
      {text.split(/(\{[a-zA-Z][a-zA-Z0-9_]*\})/g).map((part, index) => {
        const name = part.slice(1, -1);
        const value = /^\{[a-zA-Z][a-zA-Z0-9_]*\}$/.test(part) && Object.hasOwn(slots, name) ? slots[name] : part;
        return <Fragment key={index}>{value}</Fragment>;
      })}
    </>
  );
}
