/** Исполнители демонстрации доступны только в памяти; ни один профиль не подключается к сервису. */
import type { AiAccess } from '@shared/ai-access';
export const storyAccess: AiAccess = {
  agent: { provider: 'codex', selected: true, available: true, message: '' },
  image: { provider: 'test', selected: true, available: true, message: '' },
  video: { provider: 'test', selected: true, available: true, message: '' }
};
