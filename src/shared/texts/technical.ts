/** Подписи без кириллицы тоже принадлежат словарю, когда обозначают текст интерфейса, а не данные. */
export const technicalTexts = {
  files: { mp3: 'MP3' },
  percent: (value: string): string => `${value}%`
} as const;
