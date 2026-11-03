import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';

/** Таблицы принадлежат словарю; прежние экспорты сохраняют контракт страницы без второго источника подписей. */
export const VERDICT_LABELS: Record<string, { label: string; color: 'primary' | 'warning' | 'success' | 'inherit' | 'error' }> = {
  approve: { label: productionTexts.verdictLabels.approve, color: 'success' },
  revise: { label: productionTexts.verdictLabels.revise, color: 'warning' },
  send: { label: productionTexts.verdictLabels.send, color: 'primary' },
  park: { label: productionTexts.verdictLabels.park, color: 'inherit' },
  accept: { label: productionTexts.verdictLabels.accept, color: 'success' },
  retry: { label: productionTexts.verdictLabels.retry, color: 'warning' },
  review: { label: productionTexts.verdictLabels.review, color: 'inherit' }
};
export const VERDICT_HINTS: Record<string, string> = productionTexts.verdictHints;
export const BUSY_REASON = commonTexts.operationPending;
export const PYTHON_REASON = productionTexts.constants.pythonReason;
export { SHOT_STATE_LABELS as STATE_LABELS } from '../../components/shotState';
export type ProductionFilter = 'all' | 'attention' | 'progress' | 'planned' | 'completed' | 'stale' | 'queued';
export const FILTER_LABELS: Record<ProductionFilter, string> = productionTexts.filterLabels;
export const FILTER_EMPTY_HINTS: Record<ProductionFilter, string> = productionTexts.filterEmptyHints;
export const PRODUCTION_PASS_LABELS = productionTexts.passLabels;
export const PRODUCTION_PROPOSAL_LABELS = productionTexts.proposalLabels;
