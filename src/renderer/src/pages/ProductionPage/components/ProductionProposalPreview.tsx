/** Предложение показывается отдельно от сохранённых материалов: завершение задания не означает согласование. */
import type { ReactElement, ReactNode } from 'react';
import { Alert, Box, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionFramePrompt, ProductionProposal, ProductionRequestDraft } from '@shared/production-workflow';
import { productionInputLabel } from '@shared/production-labels';
import { AgentIcon } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CheckIcon from '@mui/icons-material/Check';
import { PRODUCTION_PASS_LABELS, PRODUCTION_PROPOSAL_LABELS } from '../constants';
import { RequestParameters } from './RequestParameters';
import { Prose } from '../../../components/Prose';
import { ReadableValue } from '../../../components/ReadableValue';

const FRAME_ROLES: Record<ProductionFramePrompt['role'], string> = { first: 'Первый кадр', middle: 'Промежуточный кадр', last: 'Последний кадр' };
const COMMANDS: Record<string, string> = {
  text_to_video: 'видео по тексту',
  image_to_video: 'видео по опорным кадрам',
  omni_ref_video: 'видео по референсам',
  motion_control: 'видео по движению'
};

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

function RequestDraft({ request }: { request: ProductionRequestDraft }): ReactElement {
  return (
    <Stack spacing={1.5}>
      <Section title="Модель и команда">
        <Typography variant="body2">
          {request.model} · {COMMANDS[request.command] ?? request.command} · результатов: {request.outputs}
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

function Proposed({ proposal }: { proposal: ProductionProposal }): ReactElement {
  const after = proposal.after;
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
      return <RequestDraft request={after.request} />;
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
  return (
    <>
      <DestructiveButton
        label="Применить предложение"
        description="Предложение будет записано в пакет и изменит соответствующие материалы. Принятие и платная отправка требуют отдельного согласования."
        confirmLabel="Применить"
        startIcon={<CheckIcon />}
        variant="contained"
        disabled={busy || !ready}
        onConfirm={onApply}
      />
      <DestructiveButton
        label="Отклонить предложение"
        description="Предложение будет отклонено без применения к пакету."
        confirmLabel="Отклонить"
        disabled={busy}
        onConfirm={onDiscard}
      />
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
  fill = false
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
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
          {after.images.map((image) => (
            <Box key={image.id} sx={{ width: 240 }}>
              <Box
                component="img"
                src={window.api.shell.fileUrl(image.path)}
                alt={`Кандидат ${image.id}`}
                sx={{ width: '100%', maxHeight: 180, objectFit: 'contain' }}
              />
              <Typography variant="caption">{image.id} · кандидат, не принят</Typography>
              <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }}>
                {image.path}
              </Typography>
            </Box>
          ))}
        </Stack>
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
            <Proposed proposal={proposal} />
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
