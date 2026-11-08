/** Общая обвязка инструкций; названия, команды и адреса агентов остаются в их реестре. */
export const agentInstructionsTexts = {
  terminal: 'терминале',
  windowsTerminal: 'PowerShell или CMD',
  install: ({ provider }: { provider: string }) => `Установите ${provider} по официальной инструкции и повторите проверку.`,
  // Именованный слот сохраняет целую фразу, а элемент code создаёт только renderer.
  login: ({ terminal }: { terminal: string }) => `Выполните вход в ${terminal}: {command}.`,
  status: 'Проверка вручную: {command}.',
  installation: 'Установка',
  authorization: 'Вход и проверка'
} as const;
