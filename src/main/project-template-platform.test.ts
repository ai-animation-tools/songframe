import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectPlatformValues } from './project-platform';
import { renderPlaceholders } from './template';

describe('Документация нового проекта на Linux и Windows', () => {
  it.each(['README.md', 'AGENTS.md'])('создаёт одинаковый %s с командами обеих ОС', (file) => {
    const template = readFileSync(join(process.cwd(), 'templates', 'project', file), 'utf8');
    const render = (platform: NodeJS.Platform): string =>
      renderPlaceholders(template, { project_name: 'Клип', animatic_video: 'Клип.mp4', ...projectPlatformValues(platform) });
    const linux = render('linux');
    const windows = render('win32');
    expect(linux).toBe(windows);
    expect(linux).toContain('./.songframe/run-tool');
    expect(linux).toContain('.\\.songframe\\run-tool.cmd');
    expect(linux).toContain('./.songframe/run-kling');
    expect(linux).toContain('.\\.songframe\\run-kling.cmd');
    if (file === 'README.md') {
      const ownerText = linux.split('<!-- songframe:end -->')[1];
      expect(ownerText).toContain('./.songframe/run-tool check_assets');
      expect(ownerText).toContain('.\\.songframe\\run-tool.cmd check_assets');
    }
  });
});
