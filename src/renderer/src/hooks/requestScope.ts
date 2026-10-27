/** Поздний ответ относится к тому контексту, в котором начался запрос, даже после возврата к прежнему проекту. */
export class RequestScope {
  private key: unknown;
  private revision = 0;

  update(key: unknown): void {
    if (this.key !== key) {
      this.key = key;
      this.invalidate();
    }
  }

  invalidate(): void {
    this.revision++;
  }

  capture(key: unknown = this.key): () => boolean {
    const revision = this.revision;
    return () => this.revision === revision && this.key === key;
  }
}

/** Проверяем контекст после await до любого изменения UI, а не после всего обработчика. */
export async function completeInScope<T>(operation: Promise<T>, current: () => boolean, commit: (value: T) => void): Promise<void> {
  const value = await operation;
  if (current()) commit(value);
}
