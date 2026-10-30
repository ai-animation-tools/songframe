/** Обложку готовит провайдер изображений проекта; выбранный текстовый агент на него не влияет. */
import { sourcesTexts } from '@shared/texts/sources';
import { createHash } from 'node:crypto';
import type { AgentSettings } from '@shared/agents';
import { isMediaProvider, MEDIA_PROVIDERS, mediaProviderTitles, type MediaProviderId } from '@shared/media-providers';
import { readProjectSettings } from './checks';
import type { CoverCandidateInput, CoverCandidateRunner, PreparedCoverCandidate } from './cover-generation';
import { agentAdapter } from './providers';
import type { SettingsStore } from './settings';
import { assertAiSelection } from './ai-access';

interface Options {
  settings: SettingsStore;
  /** Обложка платного провайдера: общий адаптер с конфигурацией провайдера. */
  paid(input: CoverCandidateInput, provider: MediaProviderId): Promise<PreparedCoverCandidate>;
  /** Исполнитель провайдера-агента; по умолчанию его даёт адаптер провайдера. */
  agent?: (provider: MediaProviderId, config: AgentSettings) => CoverCandidateRunner;
}

function adapterCover(provider: MediaProviderId, config: AgentSettings): CoverCandidateRunner {
  const adapter = agentAdapter(provider);
  if (!adapter) throw new Error(sourcesTexts.main.coverAdapterMissing({ title: MEDIA_PROVIDERS[provider].title }));
  return adapter.cover({ config });
}

export async function prepareProjectCover(input: CoverCandidateInput, options: Options): Promise<PreparedCoverCandidate> {
  assertAiSelection(options.settings, input.project, 'image');
  if (input.signal.aborted) throw new Error(sourcesTexts.main.coverPreparationStopped);
  const settings = readProjectSettings(input.project).generation?.image;
  if (!isMediaProvider(settings?.provider, 'image')) throw new Error(sourcesTexts.main.imageProviderRequired({ titles: mediaProviderTitles('image') }));
  const provider = settings.provider;
  if (!MEDIA_PROVIDERS[provider].executor) return options.paid(input, provider);
  // Провайдер-агент: пустая проектная модель означает настройки самой программы, как и при генерации опор.
  const config = options.settings.getImageAgent(provider, settings.model);
  const runner = (options.agent ?? adapterCover)(provider, config);
  return {
    provider,
    model: config.model ?? null,
    requestSha: createHash('sha256')
      .update(JSON.stringify({ prompt: input.prompt, config, workDir: input.workDir }))
      .digest('hex'),
    quote: null,
    generate: (signal) => runner({ ...input, signal })
  };
}
