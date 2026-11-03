import { productionTexts } from './texts/production';
/** Общие подписи попыток для производства и подтверждения сохранённого запроса. */
export const ATTEMPT_LABELS: Record<string, string> = productionTexts.attemptLabels;

const INPUT_ROLES: Record<string, string> = productionTexts.inputRoles;

const INPUT_SLOTS: Record<string, string> = productionTexts.inputSlots;

const NUMBERED_INPUT_SLOTS: Record<string, string> = { ...INPUT_SLOTS, keyframe: productionTexts.input.keyframeSlot };

/** Роль опоры понятнее пользователю, а номер сохраняет различие между входами одного вида. */
export function productionInputLabel(input: { slot?: string; role?: string }): string {
  const role = input.role ? INPUT_ROLES[input.role] : undefined;
  const numbered = /^(image|video|audio|keyframe|tail_image)_(\d+)$/.exec(input.slot ?? '');
  const slot = numbered ? `${NUMBERED_INPUT_SLOTS[numbered[1]]} ${numbered[2]}` : input.slot ? (INPUT_SLOTS[input.slot] ?? input.slot) : undefined;
  return role ? `${role}${slot && slot !== role ? ` (${slot})` : ''}` : (slot ?? input.role ?? productionTexts.input.input);
}

/** Пакет подготовлен по прежней постановке плана: общий текст для проблемы пакета и её показа в интерфейсе. */
export const SCENE_CHANGED = productionTexts.input.sceneChanged;
