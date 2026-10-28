/** Сведения тестового провайдера медиа `test` для реестра; используются только тестами main и renderer. */
import type { MediaProviderInfo } from '../media-providers';

export const TEST_PROVIDER = 'test';

export const testProviderInfo: MediaProviderInfo = {
  title: 'Тестовый сервис',
  kinds: ['image', 'video'],
  executor: null,
  paid: true,
  lipSync: { min: 5, max: 30 },
  learnsPriceFromCharges: true,
  generationHistory: 'историю тестового сервиса',
  requestParameters: true,
  defaultModelLabel: 'Автоматически по задаче',
  capabilitiesNote: 'Проверка тестового сервиса не запускает генерацию.',
  settingsNotes: {},
  defaults: { image: { resolution: '2k', aspect_ratio: '16:9', outputs: 1 } },
  modelOrder: { image: ['test-image-pro', 'test-image'], video: ['test-video-pro', 'test-video'] },
  commandLabels: { image_to_video: 'видео по опорным кадрам' }
};

/** Тестовый провайдер изображений `test-agent`: генерацию исполняет программа-агент из реестра агентов. */
export const TEST_AGENT_PROVIDER = 'test-agent';

export const testAgentProviderInfo: MediaProviderInfo = {
  ...testProviderInfo,
  title: 'Тестовый агент изображений',
  kinds: ['image'],
  executor: 'codex',
  paid: false,
  lipSync: null,
  learnsPriceFromCharges: false,
  generationHistory: null,
  requestParameters: false,
  defaultModelLabel: 'Как указано в настройках программы',
  capabilitiesNote: 'Проверка тестового агента не создаёт изображений.',
  defaults: {},
  modelOrder: {},
  commandLabels: {}
};
