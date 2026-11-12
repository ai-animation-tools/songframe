/**
 * Предел длины видеопромпта провайдера на шаге «Видеопромпт»: длина считается по символам Unicode,
 * как в Go (toolrt.Len), а предел приходит из ProductionWorkflowView.promptMaxChars. Утверждение сверх
 * предела Go отклоняет и сам; здесь — чтобы показать причину до нажатия.
 */

/** Длина промпта и предел, если промпт длиннее; иначе null. */
export interface PromptOverLimit {
  chars: number;
  limit: number;
}

/** Промпт длиннее предела провайдера; нет текста или предела — null. */
export function promptOverLimit(text: string | null | undefined, limit: number | null | undefined): PromptOverLimit | null {
  if (!text || !limit || limit <= 0) return null;
  const chars = Array.from(text).length;
  return chars > limit ? { chars, limit } : null;
}
