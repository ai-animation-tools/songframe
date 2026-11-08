import { commonTexts } from './common';

/** Тексты создания проекта и истории папок; технические значения и проверки остаются у страниц. */
export const projectsTexts = {
  created: ({ name }: { name: string }) => `Проект «${name}» создан`,
  creating: 'Дождитесь создания проекта.',
  nameRequired: commonTexts.project.nameRequired,
  folderRequired: 'Укажите папку проекта.',
  formProblems: 'Исправьте проблемы, перечисленные в форме.',
  validating: 'Дождитесь окончания проверки формы.',
  afterCreation: 'После создания откроется страница исходников: трек, текст песни, идея клипа, обложка и референсы.',
  chooseParent: 'Где создать папку проекта',
  folderPath: 'Полный путь к новой папке',
  folderHelp: 'Папка ещё не должна существовать. Она будет заполнена из шаблона; репозиторий Git создаётся, если Git установлен. Без него проект тоже работает',
  parentFolder: 'Родительская папка',
  clipName: 'Название клипа',
  nameHelp: 'Попадёт в plan/project.json, README и заголовки документов',
  animaticName: 'Имя MP4 аниматика (необязательно)',
  animaticNameHelp: 'Латиница, цифры, дефис; по умолчанию образуется из названия',
  chooseProjectFolder: 'Папка проекта клипа',
  emptyHistory: 'История пуста. Откройте папку существующего клипа или создайте новый проект.',
  forget: ({ name }: { name: string }) => `Убрать проект «${name}» из истории`,
  forgetDescription: 'Из истории будет удалена только запись о проекте. Папка проекта и все её файлы останутся на диске.',
  opening: 'Дождитесь открытия проекта.',
  forgetConfirm: 'Убрать из истории',
  current: 'текущий',
  // Дата уже отформатирована владельцем; без даты суффикс «открыт …» не добавляется.
  historyDetails: ({ path, exists, openedAt }: { path: string; exists: boolean; openedAt: string | null | undefined }) =>
    `${path}${exists ? '' : ' (папка не найдена)'}${openedAt ? ` · открыт ${openedAt}` : ''}`
} as const;
