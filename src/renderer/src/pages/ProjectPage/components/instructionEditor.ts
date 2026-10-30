/** Разблокировка действует только после явного подтверждения; сохранение и смена контекста сбрасывают редактор. */
export type InstructionEditorState = 'locked' | 'confirming' | 'editing';
export type InstructionEditorAction = 'request' | 'cancel' | 'confirm' | 'lock';

export function instructionEditor(state: InstructionEditorState, action: InstructionEditorAction): InstructionEditorState {
  if (action === 'lock') return 'locked';
  if (action === 'request' && state === 'locked') return 'confirming';
  if (action === 'cancel' && state === 'confirming') return 'locked';
  if (action === 'confirm' && state === 'confirming') return 'editing';
  return state;
}
