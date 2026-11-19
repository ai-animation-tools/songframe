import { productionTexts } from '@shared/texts/production';
/** Предложение показывается отдельно от сохранённых материалов: завершение задания не означает согласование. */
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Alert, Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionFramePrompt, ProductionProposal, ProductionScenarioProblem } from '@shared/production-workflow';
import { copyShotFrame } from '@shared/production-workflow';
import { AgentButton, AgentIcon, ImageGallery, ImageThumbnail } from '../../../components';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CheckIcon from '@mui/icons-material/Check';
import EditIcon from '@mui/icons-material/Edit';
import { BUSY_REASON, PRODUCTION_PASS_LABELS, PRODUCTION_PROPOSAL_LABELS } from '../constants';
import { Prose } from '../../../components/Prose';
import { ReadableValue } from '../../../components/ReadableValue';
import type { PromptVariant } from '@shared/types';
import { PromptVariantsText } from './PromptVariantsText';

const FRAME_ROLES: Record<ProductionFramePrompt['role'], string> = productionTexts.inputRoles;

/** Пояснение копии опоры: копия более ранней опоры или кадр принятого плана. */
function copyText(source: string): string {
  const frame = copyShotFrame(source);
  return frame ? productionTexts.productionProposalPreview.copyOfShotFrame(frame) : productionTexts.productionProposalPreview.copyOf({ source });
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Колонка сравнения: заголовок отделён от содержимого фоном и линией, содержимое прокручивается внутри. */
function Column({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  const titleId = useId();
  return (
    <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
        <Typography id={titleId} variant="subtitle1" fontWeight={700}>
          {title}
        </Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </Box>
      {/* Прокручиваемое содержимое доступно с клавиатуры; рамка фокуса внутри, иначе её обрезает Paper. */}
      <Box
        role="region"
        aria-labelledby={titleId}
        tabIndex={0}
        sx={{
          p: 2,
          overflowY: 'auto',
          minHeight: 0,
          flex: 1,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
        }}
      >
        {children}
      </Box>
    </Paper>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary" display="block" sx={{ lineHeight: 1.8 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Paragraphs({ text }: { text: string }): ReactElement {
  return <Prose text={text} />;
}

function Frames({ frames }: { frames: ProductionFramePrompt[] }): ReactElement {
  return (
    <Stack spacing={1}>
      {frames.map((frame) => (
        <Paper key={frame.id} variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 0.5 }}>
            <Chip size="small" color="primary" variant="outlined" label={frame.id} />
            <Typography variant="body2" fontWeight={600}>
              {FRAME_ROLES[frame.role] ?? frame.role}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {productionTexts.productionProposalPreview.time({ timeSeconds: frame.timeSeconds })}
            </Typography>
          </Stack>
          {frame.copyOf ? (
            <Typography variant="body2" color="text.secondary">
              {copyText(frame.copyOf)}
            </Typography>
          ) : (
            <Paragraphs text={frame.prompt} />
          )}
          {frame.referencePaths.length ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              {productionTexts.productionProposalPreview.references({ filenames: frame.referencePaths.map(fileName).join(', ') })}
            </Typography>
          ) : null}
        </Paper>
      ))}
    </Stack>
  );
}

/** Кандидаты опор задания: подпись без пути файла, путь — в подсказке; щелчок открывает набор крупно. */
function FrameCandidates({ images }: { images: { id: string; path: string }[] }): ReactElement {
  const [active, setActive] = useState<number | null>(null);
  const gallery = images.map((image) => ({ imagePath: image.path, label: productionTexts.productionProposalPreview.candidate({ id: image.id }) }));
  return (
    <>
      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {gallery.map((image, index) => (
          <Box key={image.imagePath} sx={{ width: 240, minWidth: 0 }}>
            <ImageThumbnail path={image.imagePath} label={image.label} title={image.imagePath} dashed highlight="warning" onOpen={() => setActive(index)} />
            <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
              {image.label}
            </Typography>
          </Box>
        ))}
      </Stack>
      {active !== null ? (
        <ImageGallery kind={productionTexts.productionProposalPreview.galleryKind} images={gallery} initialIndex={active} onClose={() => setActive(null)} />
      ) : null}
    </>
  );
}

/** Текущее состояние пакета для сравнения: до первого описания или промпта его ещё нет, и это нормально. */
function Current({ proposal }: { proposal: ProductionProposal }): ReactElement {
  const before = proposal.before;
  if (!before.trim()) {
    return (
      <Alert severity="info">
        {proposal.stage === 'description' ? productionTexts.productionProposalPreview.firstDescription : productionTexts.productionProposalPreview.firstPrompt}
      </Alert>
    );
  }
  if (proposal.stage === 'frames') {
    return <CurrentFrames before={before} />;
  }
  return <Paragraphs text={before} />;
}

/** Опоры попытки до предложения: Go присылает поле keyframes пакета JSON-строкой, человеку — строка на опору. */
function CurrentFrames({ before }: { before: string }): ReactElement {
  const texts = productionTexts.productionProposalPreview;
  let frames: { id?: unknown; role?: unknown; time_seconds?: unknown; path?: unknown; approved?: unknown }[] = [];
  try {
    const parsed: unknown = JSON.parse(before);
    frames = Array.isArray(parsed) ? parsed : [];
  } catch {
    return <Paragraphs text={before} />;
  }
  if (frames.length === 0) {
    return <Typography variant="body2">{texts.currentFramesEmpty}</Typography>;
  }
  return (
    <Stack spacing={0.5}>
      {frames.map((frame, index) => {
        const role =
          typeof frame.role === 'string' && frame.role in FRAME_ROLES ? FRAME_ROLES[frame.role as ProductionFramePrompt['role']] : String(frame.role ?? '');
        const state =
          frame.approved === true ? texts.currentFrameState.approved : frame.path ? texts.currentFrameState.candidate : texts.currentFrameState.missing;
        const seconds = String(frame.time_seconds ?? '').replace('.', ',');
        return (
          <Typography key={`${String(frame.id)}-${index}`} variant="body2">
            {texts.currentFrame({ id: String(frame.id ?? ''), role, seconds, state })}
          </Typography>
        );
      })}
    </Stack>
  );
}

const problemTexts = productionTexts.productionProposalPreview;

/** Исправления отказа: противоречия состояния с предложенным значением. */
export function scenarioFixes(proposal: ProductionProposal): ProductionScenarioProblem[] {
  return (proposal.problems ?? []).filter((problem) => 'entity' in problem && problem.fix !== null);
}

/** Одно противоречие: где, что сейчас и откуда, в чём расхождение и что станет. */
function ScenarioProblem({ problem }: { problem: ProductionScenarioProblem }): ReactElement {
  if (!('entity' in problem))
    return (
      <Paper variant="outlined" sx={{ p: 1.5 }} data-testid="scenario-problem">
        <Typography variant="subtitle2">{problemTexts.problemField[problem.field]}</Typography>
        <Typography variant="body2">{problem.conflict}</Typography>
      </Paper>
    );
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-testid="scenario-problem">
      <Stack spacing={0.75}>
        <Typography variant="subtitle2">
          {[problemTexts.problemPhase[problem.phase], problem.entityName || problem.entity, problem.propertyLabel || problem.property].join(' · ')}
        </Typography>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {problemTexts.problemNow}
            {problem.source ? ` · ${problemTexts.problemSource(problem.source)}` : ''}
          </Typography>
          <Typography variant="body2">{problem.current ?? problemTexts.problemEmpty}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            {problemTexts.problemConflict}
          </Typography>
          <Typography variant="body2">{problem.conflict}</Typography>
        </Box>
        {problem.fix !== null ? (
          <Box>
            <Typography variant="caption" color="success.main" fontWeight={600}>
              {problemTexts.problemFix}
            </Typography>
            <Typography variant="body2" fontWeight={500}>
              {problem.fix}
            </Typography>
          </Box>
        ) : (
          <Alert severity="warning" sx={{ py: 0 }}>
            {problemTexts.problemNoFix}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * Предложенный текст этапа. Видеопромпт с переводом показывается переключателем «Оригинал / Перевод»; при
 * onSendVariant показанный вариант и есть выбранный к отправке, с ним окно примет предложение.
 */
function Proposed({
  proposal,
  sendVariant = 'original',
  onSendVariant
}: {
  proposal: ProductionProposal;
  sendVariant?: PromptVariant;
  onSendVariant?(variant: PromptVariant): void;
}): ReactElement {
  const after = proposal.after;
  if (!after && proposal.refused && proposal.problems?.length)
    // Отказ со списком противоречий: итог агента и по каждому противоречию — было, почему и что станет.
    return (
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">{productionTexts.productionProposalPreview.refused}</Typography>
        {proposal.agentText ? (
          <Section title={productionTexts.productionProposalPreview.refusalReason}>
            <Paragraphs text={proposal.agentText} />
          </Section>
        ) : null}
        <Section title={problemTexts.problems({ count: proposal.problems.length })}>
          <Stack spacing={1}>
            {proposal.problems.map((problem, index) => (
              <ScenarioProblem key={index} problem={problem} />
            ))}
          </Stack>
        </Section>
      </Stack>
    );
  if (!after && proposal.agentText && proposal.refused)
    // Штатный отказ агента: его причина и есть объяснение, технической ошибки разбора здесь нет.
    return (
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">{productionTexts.productionProposalPreview.refused}</Typography>
        <Section title={productionTexts.productionProposalPreview.refusalReason}>
          <Paragraphs text={proposal.agentText} />
        </Section>
      </Stack>
    );
  if (!after && proposal.agentText)
    // Ответ агента не прошёл проверку: показываем, что он ответил, и почему приложение его отклонило.
    return (
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">{productionTexts.productionProposalPreview.noProposal}</Typography>
        <Section title={productionTexts.productionProposalPreview.agentAnswer}>
          <Paragraphs text={proposal.agentText} />
        </Section>
        {proposal.message ? (
          <Section title={productionTexts.productionProposalPreview.validationReason}>
            <Typography variant="body2">{proposal.message}</Typography>
          </Section>
        ) : null}
      </Stack>
    );
  if (!after) return <Paragraphs text={productionTexts.productionProposalPreview.pending} />;
  switch (after.stage) {
    case 'description':
      return (
        <Stack spacing={2}>
          <Section title={productionTexts.productionProposalPreview.description}>
            <Paragraphs text={after.description} />
          </Section>
          <Section title={productionTexts.productionProposalPreview.duration}>
            <Typography variant="body2">{productionTexts.productionProposalPreview.seconds({ requestSeconds: after.requestSeconds })}</Typography>
          </Section>
          <Section title={productionTexts.productionProposalPreview.frames({ frames: after.keyframes.length })}>
            <Frames frames={after.keyframes} />
          </Section>
        </Stack>
      );
    case 'prompt':
      if (!after.translation) return <Paragraphs text={after.prompt} />;
      return (
        <PromptVariantsText
          text={after.prompt}
          variants={{ original: after.prompt, translation: after.translation }}
          title={(characters) => productionTexts.productionProposalPreview.promptTitle({ characters })}
          status={onSendVariant ? productionTexts.promptVariants.selected({ translation: sendVariant === 'translation' }) : undefined}
          statusHint={onSendVariant ? productionTexts.promptVariants.sendHint : undefined}
          shown={onSendVariant ? sendVariant : undefined}
          onShownChange={onSendVariant}
        />
      );
    default:
      return <ReadableValue value={after} />;
  }
}

export function ProposalActions({
  proposal,
  busy,
  revising = false,
  reviseNote,
  onReviseOpen,
  onRevise,
  onApply,
  onDiscard,
  onFixScenario,
  fixRestarts = false,
  applyBlockedReason = null
}: {
  proposal: ProductionProposal;
  busy: boolean;
  /** Исправить сценарий по отказу агента; без обработчика кнопки нет. */
  onFixScenario?(): void;
  /** После исправления панель сама подготовит описание заново (новая попытка). */
  fixRestarts?: boolean;
  /** Принять предложение нельзя по его содержанию (например, промпт сверх предела провайдера): причина; доработка остаётся. */
  applyBlockedReason?: string | null;
  /** Открыто поле замечания: кнопка доработки запускает агента. */
  revising?: boolean;
  reviseNote?: string;
  onReviseOpen?(): void;
  onRevise?(): void;
  onApply(): void;
  onDiscard(): void;
}): ReactElement | null {
  const ready = proposal.status === 'ready' && !proposal.stale && !!proposal.after;
  const fixes = scenarioFixes(proposal);
  // Принятие закрыло бы предложение и потеряло введённое замечание: пока оно есть, принять нельзя.
  const noteFilled = revising && !!reviseNote?.trim();
  if (proposal.status === 'applied' || proposal.status === 'running') return null;
  const applyReason = busy
    ? BUSY_REASON
    : proposal.stale
      ? productionTexts.productionProposalPreview.staleReason
      : proposal.status !== 'ready'
        ? productionTexts.productionProposalPreview.invalidReason
        : !proposal.after
          ? productionTexts.productionProposalPreview.emptyReason
          : null;
  return (
    <>
      <DestructiveButton
        label={productionTexts.productionProposalPreview.discard}
        description={productionTexts.productionProposalPreview.discardDescription}
        confirmLabel={productionTexts.productionProposalPreview.discardConfirm}
        disabled={busy}
        disabledReason={BUSY_REASON}
        onConfirm={onDiscard}
      />
      {onRevise ? (
        revising ? (
          <AgentButton
            disabled={busy || !ready || !reviseNote?.trim()}
            disabledReason={busy ? BUSY_REASON : (applyReason ?? productionTexts.productionWorkflowPanel.noteReason)}
            onClick={onRevise}
          >
            {productionTexts.productionWorkflowPanel.revise}
          </AgentButton>
        ) : (
          <ActionButton startIcon={<EditIcon />} disabled={busy || !ready} disabledReason={applyReason} onClick={onReviseOpen}>
            {productionTexts.verdictLabels.revise}
          </ActionButton>
        )
      ) : null}
      {onFixScenario && fixes.length ? (
        fixRestarts ? (
          <AgentButton
            variant="contained"
            disabled={busy || proposal.stale}
            disabledReason={busy ? BUSY_REASON : problemTexts.fixStaleReason}
            title={problemTexts.fixHint({ count: fixes.length })}
            onClick={onFixScenario}
          >
            {problemTexts.fixAndPrepare}
          </AgentButton>
        ) : (
          <ActionButton
            variant="contained"
            startIcon={<EditIcon />}
            disabled={busy || proposal.stale}
            disabledReason={busy ? BUSY_REASON : problemTexts.fixStaleReason}
            title={problemTexts.fixHint({ count: fixes.length })}
            onClick={onFixScenario}
          >
            {problemTexts.fix}
          </ActionButton>
        )
      ) : null}
      <ActionButton
        variant="contained"
        startIcon={<CheckIcon />}
        disabled={busy || !ready || !!applyBlockedReason || noteFilled}
        disabledReason={applyReason ?? applyBlockedReason ?? (noteFilled ? productionTexts.packageDecision.noteFilled : null)}
        onClick={onApply}
      >
        {productionTexts.productionProposalPreview.apply}
      </ActionButton>
    </>
  );
}

export function ProductionProposalPreview({
  proposal,
  provider = null,
  busy,
  onApply,
  onDiscard,
  actions = true,
  fill = false,
  sendVariant,
  onSendVariant
}: {
  proposal: ProductionProposal;
  provider?: AgentSettings['provider'] | null;
  busy: boolean;
  onApply(): void;
  onDiscard(): void;
  /** Кнопки внутри превью; диалог выносит их в свою строку действий. */
  actions?: boolean;
  /** Занять всю высоту контейнера: колонки прокручиваются внутри себя. */
  fill?: boolean;
  /** Вариант видеопромпта с переводом к отправке и его выбор переключателем показа; без обработчика переключатель только для просмотра. */
  sendVariant?: PromptVariant;
  onSendVariant?(variant: PromptVariant): void;
}): ReactElement {
  const after = proposal.after;
  return (
    <Stack spacing={1.5} sx={fill ? { height: '100%', minHeight: 0 } : undefined}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {provider ? <AgentIcon provider={provider} /> : null}
        <Typography fontWeight={600}>{productionTexts.productionProposalPreview.title({ stage: PRODUCTION_PASS_LABELS[proposal.stage] })}</Typography>
      </Stack>
      <Alert severity={proposal.stale || ['failed', 'invalid', 'interrupted'].includes(proposal.status) ? 'warning' : 'info'}>
        {productionTexts.productionProposalPreview.notice({
          stale: proposal.stale,
          message: proposal.message,
          status: PRODUCTION_PROPOSAL_LABELS[proposal.status]
        })}
      </Alert>
      {after?.stage === 'frames' ? (
        <FrameCandidates images={after.images} />
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            gap: 2,
            minHeight: 0,
            flex: fill ? 1 : undefined,
            '& > *': { maxHeight: fill ? '100%' : 420 }
          }}
        >
          <Column title={productionTexts.productionProposalPreview.current} hint={productionTexts.productionProposalPreview.currentHint}>
            <Current proposal={proposal} />
          </Column>
          <Column title={productionTexts.productionProposalPreview.proposed} hint={productionTexts.productionProposalPreview.proposedHint}>
            <Proposed proposal={proposal} sendVariant={sendVariant} onSendVariant={onSendVariant} />
          </Column>
        </Box>
      )}
      {actions ? (
        <>
          <Divider />
          <Stack direction="row" spacing={1}>
            <ProposalActions proposal={proposal} busy={busy} onApply={onApply} onDiscard={onDiscard} />
          </Stack>
        </>
      ) : null}
    </Stack>
  );
}
