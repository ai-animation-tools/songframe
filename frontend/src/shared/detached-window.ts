/**
 * Контракт отдельного окна приложения (плеер монтажа, вид из камеры): пара «окно-владелец — отдельное окно»
 * обменивается сообщениями своего вида через Go (`internal/app/detached_window.go`). Сообщение получает только
 * противоположная сторона пары, закрытие отдельного окна — только владелец. Одновременно открыто не больше одного
 * окна каждого вида; закрытие владельца закрывает и его.
 */

/** Сообщение пары с её сессией — так владелец отличает своё окно от прежнего. */
export interface DetachedWindowEvent<Message> {
  session: string;
  message: Message;
}

export interface DetachedWindowApi<Message> {
  /** Открывает окно сессии session; второе окно того же вида — ошибка с понятным текстом. */
  open(session: string): Promise<void>;
  close(session: string): Promise<void>;
  /** Отправляет сообщение другой стороне; ошибка доставки уходит в журнал, порядок сообщений сохраняется. */
  send(message: Message): void;
  onMessage(listener: (event: DetachedWindowEvent<Message>) => void): () => void;
  onClosed(listener: (session: string) => void): () => void;
}
