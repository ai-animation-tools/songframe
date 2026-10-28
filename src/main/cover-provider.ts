/** Обложку готовит провайдер изображений проекта; выбранный текстовый агент на него не влияет. */
import { createHash } from 'node:crypto';
import type { AgentSettings } from '@shared/agents';
import { isMediaProvider, mediaProviderTitles, type MediaProviderFor } from '@shared/media-providers';
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
  assertAiSelection(options.settings, input.project, 'image');
  if (input.signal.aborted) throw new Error('Подготовка обложки остановлена.');
  const settings = readProjectSettings(input.project).generation?.image;
  if (!isMediaProvider(settings?.provider, 'image'))
    throw new Error(`Выберите поддерживаемого провайдера изображений в настройках проекта: ${mediaProviderTitles('image')}.`);
  // Record требует подготовки обложки для каждого провайдера изображений из реестра.
  const preparers: Record<MediaProviderFor<'image'>, () => Promise<PreparedCoverCandidate>> = {
    kling: () => options.kling(input),
    codex: async () => {
      // Пустая проектная модель означает настройки самого Codex, как и при генерации опор.
      const config: AgentSettings = { ...options.settings.getImageAgent(), model: settings?.model?.trim() || undefined };
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
  };
  return preparers[settings.provider]();
}
