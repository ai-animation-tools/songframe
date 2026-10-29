/** Предложение показывается отдельно от сохранённых материалов: завершение задания не означает согласование. */
import { useState, type ReactElement, type ReactNode } from 'react';
import { Alert, Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionFramePrompt, ProductionProposal, ProductionRequestDraft } from '@shared/production-workflow';
import { productionInputLabel } from '@shared/production-labels';
import { mediaCommandLabel } from '@shared/media-providers';
import { AgentIcon, ImageGallery, ImageThumbnail } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CheckIcon from '@mui/icons-material/Check';
import { BUSY_REASON, PRODUCTION_PASS_LABELS, PRODUCTION_PROPOSAL_LABELS } from '../constants';
import { RequestParameters } from './RequestParameters';
import { Prose } from '../../../components/Prose';
import { ReadableValue } from '../../../components/ReadableValue';

const FRAME_ROLES: Record<ProductionFramePrompt['role'], string> = { first: 'Первый кадр', middle: 'Промежуточный кадр', last: 'Последний кадр' };

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Колонка сравнения: заголовок отделён от содержимого фоном и линией, содержимое прокручивается внутри. */
function Column({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle1" fontWeight={700}>
          {title}
        </Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </Box>
      <Box sx={{ p: 2, overflowY: 'auto', minHeight: 0, flex: 1 }}>{children}</Box>
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
              {frame.timeSeconds} с от начала плана
            </Typography>
          </Stack>
          <Paragraphs text={frame.prompt} />
          {frame.referencePaths.length ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              Референсы: {frame.referencePaths.map(fileName).join(', ')}
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
  const gallery = images.map((image) => ({ imagePath: image.path, label: `${image.id} · кандидат, не принят` }));
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
      {active !== null ? <ImageGallery kind="Кандидат опоры" images={gallery} initialIndex={active} onClose={() => setActive(null)} /> : null}
    </>
  );
}

function RequestDraft({ request, videoProvider }: { request: ProductionRequestDraft; videoProvider: string | null }): ReactElement {
  return (
    <Stack spacing={1.5}>
      <Section title="Модель и команда">
        <Typography variant="body2">
          {request.model} · {mediaCommandLabel(videoProvider, request.command)} · результатов: {request.outputs}
        </Typography>
      </Section>
      <Section title="Входные материалы">
        {request.inputs.length ? (
          <Stack spacing={0.25}>
            {request.inputs.map((input, index) => (
              <Typography key={`${input.slot ?? input.flag}-${index}`} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {productionInputLabel(input)}: {fileName(input.path)}
              </Typography>
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Без входных файлов
          </Typography>
        )}
      </Section>
      <RequestParameters parameters={request.parameters} />
    </Stack>
  );
}

/** Текущее состояние пакета для сравнения: до первого описания или промпта его ещё нет, и это нормально. */
function Current({ proposal }: { proposal: ProductionProposal }): ReactElement {
  const before = proposal.before;
  if (proposal.stage === 'request') {
    let workflow: { stage?: string; request_dir?: string; keyframes?: unknown[]; prompt?: { approved?: boolean } } | null;
    try {
      workflow = before ? JSON.parse(before) : null;
    } catch {
      workflow = null;
    }
    if (!workflow) return <Paragraphs text="Текущий запрос пакета не прочитан." />;
    return (
      <Stack spacing={1}>
        <Typography variant="body2">Этап пакета: {workflow.stage ?? 'не задан'}.</Typography>
        <Typography variant="body2">
          {workflow.request_dir ? `Подготовленный запрос: папка ${workflow.request_dir}. ` : 'Подготовленного запроса ещё нет. '}
          Опор в пакете: {workflow.keyframes?.length ?? 0}; видеопромпт {workflow.prompt?.approved ? 'принят' : 'не принят'}.
        </Typography>
      </Stack>
    );
  }
  if (!before.trim()) {
    return (
      <Alert severity="info">
        {proposal.stage === 'description'
          ? 'В пакете ещё нет описания и плана опор: это первое предложение для него. После применения здесь будет текущее описание для сравнения со следующими.'
          : 'В пакете ещё нет видеопромпта: это первое предложение. После применения здесь будет текущий текст.'}
      </Alert>
    );
  }
  return <Paragraphs text={before} />;
}

function Proposed({ proposal, videoProvider }: { proposal: ProductionProposal; videoProvider: string | null }): ReactElement {
  const after = proposal.after;
  if (!after && proposal.agentText && proposal.refused)
    // Штатный отказ агента: его причина и есть объяснение, технической ошибки разбора здесь нет.
    return (
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия.</Typography>
        <Section title="Причина отказа">
          <Paragraphs text={proposal.agentText} />
        </Section>
      </Stack>
    );
  if (!after && proposal.agentText)
    // Ответ агента не прошёл проверку: показываем, что он ответил, и почему приложение его отклонило.
    return (
      <Stack spacing={1.5}>
        <Typography variant="subtitle2">Агент не подготовил предложение</Typography>
        <Section title="Ответ агента">
          <Paragraphs text={proposal.agentText} />
        </Section>
        {proposal.message ? (
          <Section title="Причина проверки">
            <Typography variant="body2">{proposal.message}</Typography>
          </Section>
        ) : null}
      </Stack>
    );
  if (!after) return <Paragraphs text="Предложение ещё не получено." />;
  switch (after.stage) {
    case 'description':
      return (
        <Stack spacing={2}>
          <Section title="Описание плана">
            <Paragraphs text={after.description} />
          </Section>
          <Section title="Длительность запроса">
            <Typography variant="body2">{after.requestSeconds} с</Typography>
          </Section>
          <Section title={`Опоры · ${after.keyframes.length}`}>
            <Frames frames={after.keyframes} />
          </Section>
        </Stack>
      );
    case 'prompt':
      return <Paragraphs text={after.prompt} />;
    case 'request':
      return <RequestDraft request={after.request} videoProvider={videoProvider} />;
    default:
      return <ReadableValue value={after} />;
  }
}

export function ProposalActions({
  proposal,
  busy,
  onApply,
  onDiscard
}: {
  proposal: ProductionProposal;
  busy: boolean;
  onApply(): void;
  onDiscard(): void;
}): ReactElement | null {
  const ready = proposal.status === 'ready' && !proposal.stale && !!proposal.after;
  if (proposal.status === 'applied' || proposal.status === 'running') return null;
  const applyReason = busy
    ? BUSY_REASON
    : proposal.stale
      ? 'Исходные материалы изменились: отклоните предложение и подготовьте новое.'
      : proposal.status !== 'ready'
        ? 'Агент не подготовил годное предложение: отклоните его и запустите агента заново.'
        : !proposal.after
          ? 'В предложении нет материалов для применения.'
          : null;
  return (
    <>
      <DestructiveButton
        label="Отклонить предложение"
        description="Предложение будет отклонено без применения к пакету."
        confirmLabel="Отклонить"
        disabled={busy}
        disabledReason={BUSY_REASON}
        onConfirm={onDiscard}
      />
      <DestructiveButton
        label="Применить предложение"
        description="Предложение будет записано в пакет и изменит соответствующие материалы. Принятие и платная отправка требуют отдельного согласования."
        confirmLabel="Применить"
        startIcon={<CheckIcon />}
        variant="contained"
        disabled={busy || !ready}
        disabledReason={applyReason}
        onConfirm={onApply}
      />
    </>
  );
}

export function ProductionProposalPreview({
  proposal,
  provider = null,
  videoProvider = null,
  busy,
  onApply,
  onDiscard,
  actions = true,
  fill = false
}: {
  proposal: ProductionProposal;
  provider?: AgentSettings['provider'] | null;
  /** Провайдер видео проекта: подписи команд черновика запроса берутся из реестра. */
  videoProvider?: string | null;
  busy: boolean;
  onApply(): void;
  onDiscard(): void;
  /** Кнопки внутри превью; диалог выносит их в свою строку действий. */
  actions?: boolean;
  /** Занять всю высоту контейнера: колонки прокручиваются внутри себя. */
  fill?: boolean;
}): ReactElement {
  const after = proposal.after;
  return (
    <Stack spacing={1.5} sx={fill ? { height: '100%', minHeight: 0 } : undefined}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        {provider ? <AgentIcon provider={provider} /> : null}
        <Typography fontWeight={600}>Предложение агента · {PRODUCTION_PASS_LABELS[proposal.stage]}</Typography>
      </Stack>
      <Alert severity={proposal.stale || ['failed', 'invalid', 'interrupted'].includes(proposal.status) ? 'warning' : 'info'}>
        {proposal.stale
          ? 'Исходные материалы изменились. Подготовьте новое предложение.'
          : (proposal.message ?? `${PRODUCTION_PROPOSAL_LABELS[proposal.status]}.`)}{' '}
        Применение сохраняет материалы для отдельного согласования; оно не принимает опоры, промпт или платную отправку.
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
          <Column title="Сейчас в пакете" hint="Что уже сохранено и будет заменено применением">
            <Current proposal={proposal} />
          </Column>
          <Column title="Предложение агента" hint="Станет материалами пакета после применения; согласование отдельно">
            <Proposed proposal={proposal} videoProvider={videoProvider} />
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
