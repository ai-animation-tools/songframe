/** Единое отображение даты и времени: машинное значение в <time>, текст в формате «28 октября 2026 11:20:30». */
import type { ReactElement } from 'react';
import { formatDateTime } from '../format';

export function DateTime({ value }: { value: string | number | Date }): ReactElement {
  const date = value instanceof Date ? value : new Date(value);
  return <time dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}>{formatDateTime(value)}</time>;
}
