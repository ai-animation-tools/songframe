/** Команды проекта зависят от ОС, данные и относительные Markdown-ссылки остаются общими. */
export function projectLauncher(platform: NodeJS.Platform, kind: 'tool' | 'kling'): string {
  return platform === 'win32' ? `.\\.songframe\\run-${kind}.cmd` : `./.songframe/run-${kind}`;
}

export function projectPlatformValues(platform: NodeJS.Platform): Record<string, string> {
  return {
    tool_command: projectLauncher(platform, 'tool'),
    kling_command: projectLauncher(platform, 'kling'),
    credentials_path: platform === 'win32' ? '%USERPROFILE%\\.kling\\.credentials' : '~/.kling/.credentials',
    terminal_name: platform === 'win32' ? 'PowerShell или CMD' : 'терминале',
    command_language: platform === 'win32' ? 'powershell' : 'sh'
  };
}

/** Меняем только известные ссылки на launcher; аргументы команд и остальной текст владельца сохраняются. */
export function renderProjectCommands(text: string, platform: NodeJS.Platform): string {
  return text
    .replace(/(?:\.\/\.songframe\/run-(tool|kling)(?:\.cmd)?|\.\\\.songframe\\run-(tool|kling)\.cmd)/g, (_match, unix, windows) =>
      projectLauncher(platform, unix ?? windows)
    )
    .replace(/```(?:sh|bash|powershell)\n(?=\.\/\.songframe\/|\.\\\.songframe\\)/g, `\`\`\`${platform === 'win32' ? 'powershell' : 'sh'}\n`);
}
