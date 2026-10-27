/** Провайдер изображения требует явного выбора; Codex изображений доступен только при глобальном агенте Codex. */
import { createHash } from 'node:crypto';
import type { AgentSettings } from '@shared/agents';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { readProjectSettings } from './checks';
import { createCodexCoverRunner, type CoverCandidateInput, type CoverCandidateRunner, type PreparedCoverCandidate } from './cover-generation';
import type { SettingsStore } from './settings';
import { assertAiSelection } from './ai-access';

interface Options {
  settings: SettingsStore;
  kling(input: CoverCandidateInput): Promise<PreparedCoverCandidate>;
  codex?: (config: AgentSettings) => CoverCandidateRunner;
}

export async function prepareProjectCover(input: CoverCandidateInput, options: Options): Promise<PreparedCoverCandidate> {
  // Профиль изображения выбирает исполнителя, но не заменяет явное включение агента в приложении.
  if (!options.settings.getAgent()) throw new Error(COVER_AGENT_REQUIRED);
  assertAiSelection(options.settings, input.project, 'image');
  if (input.signal.aborted) throw new Error('Подготовка обложки остановлена.');
  const settings = readProjectSettings(input.project).generation?.image;
  if (settings?.provider === 'kling') return options.kling(input);
  if (settings?.provider !== 'codex') throw new Error('Выберите поддерживаемого провайдера изображений в настройках проекта: Codex или Kling.');
  // Пустая проектная модель означает настройки Codex CLI, как и при генерации опор.
  const config: AgentSettings = { ...options.settings.getImageAgent(), model: settings.model?.trim() || undefined };
  const runner = options.codex?.(config) ?? createCodexCoverRunner(options.settings, undefined, config);
  return {
    provider: 'codex',
    model: config.model ?? null,
    requestSha: createHash('sha256')
      .update(JSON.stringify({ prompt: input.prompt, config, workDir: input.workDir }))
      .digest('hex'),
    quote: null,
    generate: (signal) => runner({ ...input, signal })
  };
}
