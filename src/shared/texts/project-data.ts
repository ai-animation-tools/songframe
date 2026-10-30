/** Подписи состояний проекта, ракурсов и заданий; сохраняемые коды остаются в types.ts. */
export const projectDataTexts = {
  referenceViews: {
    full: 'В полный рост',
    face: 'Лицо',
    front: 'Спереди',
    side: 'Сбоку',
    back: 'Сзади',
    top: 'Сверху',
    other: 'Другое'
  },
  projectStates: {
    invalid: 'Не проект',
    empty: 'Создан',
    sourced: 'Исходники загружены',
    timed: 'Трек размечен',
    scripted: 'Готов к производству',
    in_production: 'В производстве',
    complete: 'Завершён'
  },
  jobInterrupted: 'Прервано закрытием или сбоем программы'
} as const;
