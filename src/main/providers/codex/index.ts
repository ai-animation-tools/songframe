/** Адаптер Codex: изображения рисует программа-агент из реестра, отдельной программы провайдера нет. */
import { createAgentAdapter } from '../../agent-adapters';
import { readCodexModels } from '../../codex-models';
import type { AgentProviderAdapter } from '../types';
import { createCodexCoverRunner } from './codex-cover-runner';
import { CodexImageProvider } from './codex-image-provider';

export { CodexImageProvider, type CodexImageProviderOptions, type PreparedCodexRequest } from './codex-image-provider';

export const codex: AgentProviderAdapter = {
  type: 'agent',
  id: 'codex',
  images: ({ images, agentSettings }) =>
    new CodexImageProvider({
      images,
      agent: agentSettings,
      checkCodex: () => createAgentAdapter('codex').check(agentSettings()),
      listCodexModels: () => readCodexModels(agentSettings())
    }),
  cover: createCodexCoverRunner
};
