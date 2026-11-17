import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Checkbox, Chip, Stack, Typography } from '@mui/material';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import type { ScenarioCheckIssue, ScenarioCheckSeverity, ScenarioCheckView } from '@shared/scenario-workflow';
import { AgentButton } from '../../../components/AgentButton';
import { AgentJobCard } from '../../../components/AgentJobCard';
import { ActionButton } from '../../../components/ActionButton';
import { LinkedText } from '../../../components/LinkedText';
import { ScenarioDraftConflictDialog } from './ScenarioDraftConflictDialog';
import { ScenarioCheckFixDialog } from './ScenarioCheckFixDialog';
import type { useScenarioCheck } from '../useScenarioCheck';
import { useStoredNumber } from '../../../hooks/useStoredNumber';

/** Сколько проблем видно до «Показать все»: отчёт не должен отодвигать редактор на несколько экранов. */
const SHOWN_ISSUES = 5;

const SEVERITY_ORDER: ScenarioCheckSeverity[] = ['high', 'medium', 'low'];
const SEVERITY_COLOR = { high: 'error', medium: 'warning', low: 'default' } as const;

/** Якорь проблемы отчёта для перехода «К отчёту» из карточки плана. */
export const checkIssueAnchor = (index: number): string => `scenario-check-issue-${index}`;

/** Переход к проблеме отчёта: seq различает повторные нажатия на ту же проблему. */
export interface CheckIssueFocus {
  index: number;
  seq: number;
}

/** Проблема вместе с её номером в отчёте: правки и переходы ссылаются на номер, а показ сортирует по важности. */
interface NumberedIssue {
  index: number;
  issue: ScenarioCheckIssue;
}

/** Проблема ещё в работе: правки не внесены и пользователь не отметил её решённой. */
const unresolved = (issue: ScenarioCheckIssue): boolean => !issue.fixed && !issue.resolved;

/** Проблему можно исправить кнопкой: у неё есть правки состояния и она ещё в работе. */
const fixable = (issue: ScenarioCheckIssue): boolean => issue.changes.length > 0 && unresolved(issue);

/**
 * Раскрыт ли блок: 1 — да, 0 — свёрнут. Это предпочтение вида, общее для всех клипов, поэтому оно
 * хранится в профиле WebView, а не в проекте. Пока выбора не было (-1), блок раскрыт до первой проверки,
 * чтобы было видно, зачем она нужна, а с готовым отчётом свёрнут и не отодвигает редактор.
 */
const REPORT_OPEN_KEY = 'songframe.scenarioCheck.reportOpen';

/**
 * Блок «Проверка сценария»: статус последней проверки, задание агента, итог и проблемы с переходом к
 * плану. Проблемы с правками состояния исправляет приложение («Исправить», «Исправить выбранные») через
 * окно с задетыми принятыми планами; остальные — доработка плана агентом с описанием проблемы в замечании.
 * Проблему без правок можно отметить «Решено вручную». Проверка и правки читают сохранённый сценарий,
 * поэтому при несохранённых правках страница сначала предлагает сохранить или отменить их — тем же
 * диалогом, что и проходы агента. Блок — Accordion, как «Общие правила и части»: в свёрнутом виде виден
 * заголовок со статусом; раскрывается он сам, когда проверка завершилась или пользователь перешёл к проблеме
 * из карточки плана.
 */
export function ScenarioCheckPanel({
  check,
  blockedReason,
  reviseReason,
  scenesDirty,
  editorBusy,
  focus,
  entityName,
  onOpenShot,
  onRevise,
  onResolveDrafts
}: {
  check: ReturnType<typeof useScenarioCheck>;
  /** Причина, по которой страница сейчас не даёт запускать агента (идёт операция или проход). */
  blockedReason: string | null;
  /** Почему доработка плана агентом сейчас недоступна. */
  reviseReason: string | null;
  scenesDirty: boolean;
  editorBusy: boolean;
  /** Проблема, к которой перешли из карточки плана: раскрывается и прокручивается в видимую область. */
  focus: CheckIssueFocus | null;
  entityName(id: string): string;
  /** Переход к плану проблемы: проблемы состояния открывают блок состояния первого кадра. */
  onOpenShot(shot: string, issue: ScenarioCheckIssue): void;
  /** Открыть доработку планов ids с замечанием note; issue — номер проблемы в отчёте. */
  onRevise(ids: string[], note: string, issue: number): void;
  onResolveDrafts(action: 'save' | 'discard'): Promise<boolean>;
}): ReactElement {
  const [afterDrafts, setAfterDrafts] = useState<(() => void) | null>(null);
  const [resolving, setResolving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<number[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [fixIssues, setFixIssues] = useState<number[] | null>(null);
  const [storedOpen, setStoredOpen] = useStoredNumber(REPORT_OPEN_KEY, -1, (value) => value === 0 || value === 1);
  const rootRef = useRef<HTMLDivElement>(null);
  const { view, error, pending } = check;
  const running = view?.status === 'running';
  const reportOpen = storedOpen === 1 || (storedOpen === -1 && (!view || view.status === 'none'));
  // Завершившаяся проверка раскрывает отчёт: пользователь ждёт её итог.
  const lastStatus = useRef(view?.status);
  useEffect(() => {
    if (lastStatus.current === 'running' && view?.status && view.status !== 'running') setStoredOpen(1);
    lastStatus.current = view?.status;
  }, [view?.status, setStoredOpen]);
  const reason = pending || resolving ? commonTexts.operationPending : (blockedReason ?? view?.reason ?? null);
  // Правки пишут сценарий: их блокирует идущее задание агента и выполняемая операция, но не устаревший отчёт.
  const fixReason = pending || resolving ? commonTexts.operationPending : (blockedReason ?? (view?.canStart || !view?.reason ? null : view.reason));
  const report = view?.report ?? null;
  const reportKey = report ? JSON.stringify(report.issues.map((issue) => [issue.title, issue.fixed, issue.resolved])) : '';
  const openCount = report?.issues.filter(unresolved).length ?? 0;
  // Новый отчёт или внесённые правки снимают отметки: выбор относится к показанным проблемам.
  useEffect(() => setChosen([]), [reportKey]);
  const withDrafts = (action: () => void): void => {
    if (scenesDirty) setAfterDrafts(() => action);
    else action();
  };
  const resolve = async (action: 'save' | 'discard'): Promise<void> => {
    setResolving(true);
    try {
      if (await onResolveDrafts(action)) {
        const next = afterDrafts;
        setAfterDrafts(null);
        next?.();
      }
    } finally {
      setResolving(false);
    }
  };
  const issues: NumberedIssue[] = (report?.issues ?? [])
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.issue.severity) - SEVERITY_ORDER.indexOf(b.issue.severity));
  const shown = expanded ? issues : issues.slice(0, SHOWN_ISSUES);
  const selectable = chosen.filter((index) => report?.issues[index] && fixable(report.issues[index]));
  const anyFixable = !!report?.issues.some(fixable);

  // Переход выполняется один раз на нажатие «К отчёту»; список читается из ссылки, а не из зависимостей эффекта.
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  useEffect(() => {
    if (!focus) return;
    const position = issuesRef.current.findIndex((item) => item.index === focus.index);
    if (position < 0) return;
    setStoredOpen(1);
    if (position >= SHOWN_ISSUES) setExpanded(true);
    setOpen((current) => (current.includes(focus.index) ? current : [...current, focus.index]));
    // Прокрутка после раскрытия: элемент появляется в DOM на следующей отрисовке.
    const frame = requestAnimationFrame(() =>
      rootRef.current?.querySelector(`#${checkIssueAnchor(focus.index)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    );
    return () => cancelAnimationFrame(frame);
  }, [focus, setStoredOpen]);

  return (
    <>
      <Accordion
        ref={rootRef}
        expanded={reportOpen}
        onChange={(_event, next) => setStoredOpen(next ? 1 : 0)}
        slotProps={{ transition: { unmountOnExit: true } }}
        disableGutters
        variant="outlined"
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <Typography variant="subtitle1" component="h2">
              {scenarioTexts.check.title}
            </Typography>
            {view && <StatusChip view={view} />}
            {view?.stale && openCount > 0 && (
              <Typography variant="body2" color="text.secondary">
                {scenarioTexts.check.openCount({ count: openCount })}
              </Typography>
            )}
          </Stack>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
            {view?.job && (running || view.status === 'failed') && (
              <AgentJobCard compact job={view.job} onCancel={check.cancel} onRetry={() => !reason && withDrafts(() => void check.start())} />
            )}
            <Typography variant="body2" color="text.secondary">
              {scenarioTexts.check.description}
            </Typography>
            {view?.message && !running && <Alert severity={view.status === 'cancelled' ? 'info' : 'warning'}>{view.message}</Alert>}
            {view?.stale && report && <Alert severity="warning">{scenarioTexts.check.stale}</Alert>}
            {report && (
              <Stack spacing={1}>
                <Typography variant="body1">{report.summary}</Typography>
                {!issues.length && <Alert severity="success">{scenarioTexts.check.clean}</Alert>}
                <Box>
                  {shown.map(({ issue, index }) => (
                    <IssueItem
                      key={`${index}-${issue.title}`}
                      index={index}
                      issue={issue}
                      selectable={anyFixable}
                      open={open.includes(index)}
                      onToggle={(next) => setOpen((current) => (next ? [...current, index] : current.filter((item) => item !== index)))}
                      chosen={chosen.includes(index)}
                      onChoose={(next) => setChosen((current) => (next ? [...current, index] : current.filter((item) => item !== index)))}
                      fixReason={fixReason}
                      reviseReason={reason ?? reviseReason}
                      entityName={entityName}
                      onOpenShot={onOpenShot}
                      onFix={() => withDrafts(() => setFixIssues([index]))}
                      onResolve={(resolved) => void check.resolve(index, resolved)}
                      resolveReason={pending || resolving ? commonTexts.operationPending : null}
                      onRevise={() =>
                        withDrafts(() =>
                          onRevise(issue.shots, scenarioTexts.check.reviseNote({ title: issue.title, problem: issue.problem, fix: issue.fix }), index)
                        )
                      }
                    />
                  ))}
                </Box>
                {issues.length > SHOWN_ISSUES && (
                  <Box>
                    <Button size="small" onClick={() => setExpanded((value) => !value)}>
                      {expanded ? scenarioTexts.check.collapse : scenarioTexts.check.showAll({ count: issues.length })}
                    </Button>
                  </Box>
                )}
              </Stack>
            )}
            {error && (
              <Alert severity="error">
                <LinkedText text={error} />
              </Alert>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <AgentButton
                variant="outlined"
                disabled={!!reason || !view?.canStart}
                disabledReason={reason}
                onClick={() => withDrafts(() => void check.start())}
              >
                {view && view.status !== 'none' ? scenarioTexts.check.restart : scenarioTexts.check.start}
              </AgentButton>
              {anyFixable && (
                <ActionButton
                  variant="outlined"
                  startIcon={<AutoFixHighIcon />}
                  disabled={!!fixReason || !selectable.length}
                  disabledReason={fixReason ?? scenarioTexts.check.fixSelectedReason}
                  title={scenarioTexts.check.fixHint}
                  onClick={() => withDrafts(() => setFixIssues([...selectable].sort((a, b) => a - b)))}
                >
                  {scenarioTexts.check.fixSelected({ count: selectable.length })}
                </ActionButton>
              )}
            </Stack>
          </Stack>
        </AccordionDetails>
      </Accordion>
      <ScenarioDraftConflictDialog
        open={afterDrafts !== null}
        busy={resolving || editorBusy}
        onResolve={(action) => void resolve(action)}
        onClose={() => setAfterDrafts(null)}
      />
      <ScenarioCheckFixDialog
        issues={fixIssues}
        stale={!!view?.stale}
        busy={pending}
        load={check.preview}
        onClose={() => setFixIssues(null)}
        onApply={(list, keep) =>
          void check.applyFixes(list, keep).then((done) => {
            if (done) setFixIssues(null);
          })
        }
      />
    </>
  );
}

/** Заметный статус последней проверки: устаревший отчёт важнее числа проблем. */
function StatusChip({ view }: { view: ScenarioCheckView }): ReactElement {
  const count = view.report?.issues.filter(unresolved).length ?? 0;
  const high = view.report?.issues.some((issue) => issue.severity === 'high' && unresolved(issue));
  const [label, color] =
    view.status === 'none'
      ? [scenarioTexts.check.statusNone, 'default' as const]
      : view.status === 'running'
        ? [scenarioTexts.check.statusRunning, 'info' as const]
        : view.status !== 'ready'
          ? [scenarioTexts.check.statusFailed, 'warning' as const]
          : view.stale
            ? [scenarioTexts.check.statusStale, 'warning' as const]
            : count
              ? [scenarioTexts.check.statusIssues({ count }), high ? ('error' as const) : ('warning' as const)]
              : [scenarioTexts.check.statusClean, 'success' as const];
  return <Chip size="small" color={color} label={label} />;
}

/**
 * Проблема отчёта: в заголовке — отметка для «Исправить выбранные», важность, группа, суть и планы; раскрытие —
 * объяснение, переходы к планам и исправление: правками приложения или доработкой агентом.
 */
function IssueItem({
  index,
  issue,
  selectable,
  open,
  onToggle,
  chosen,
  onChoose,
  fixReason,
  reviseReason,
  entityName,
  onOpenShot,
  onFix,
  onRevise,
  onResolve,
  resolveReason
}: {
  index: number;
  issue: ScenarioCheckIssue;
  /** В отчёте есть проблемы для «Исправить выбранные»: у каждой строки место под отметку, чтобы заголовки стояли ровно. */
  selectable: boolean;
  open: boolean;
  onToggle(open: boolean): void;
  chosen: boolean;
  onChoose(chosen: boolean): void;
  fixReason: string | null;
  reviseReason: string | null;
  entityName(id: string): string;
  onOpenShot(shot: string, issue: ScenarioCheckIssue): void;
  onFix(): void;
  onRevise(): void;
  /** Поставить или снять отметку «Решено вручную». */
  onResolve(resolved: boolean): void;
  resolveReason: string | null;
}): ReactElement {
  const canFix = fixable(issue);
  const closed = !unresolved(issue);
  // Отметка стоит слева от проблемы, а не в её заголовке: заголовок Accordion — кнопка, вложенный флажок ломал бы клавиатуру.
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
      {selectable && (
        <Box sx={{ width: 34, flexShrink: 0, pt: 0.75 }}>
          {canFix && (
            <Checkbox
              size="small"
              checked={chosen}
              disabled={!!fixReason}
              slotProps={{ input: { 'aria-label': scenarioTexts.check.select({ title: issue.title }) } }}
              onChange={(event) => onChoose(event.target.checked)}
            />
          )}
        </Box>
      )}
      <Accordion
        id={checkIssueAnchor(index)}
        disableGutters
        variant="outlined"
        expanded={open}
        onChange={(_, next) => onToggle(next)}
        slotProps={{ transition: { unmountOnExit: true } }}
        sx={{ flex: 1, minWidth: 0 }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <Chip size="small" color={SEVERITY_COLOR[issue.severity]} label={scenarioTexts.check.severities[issue.severity]} />
            {issue.fixed && <Chip size="small" color="success" variant="outlined" label={scenarioTexts.check.fixed} title={scenarioTexts.check.fixedHint} />}
            {issue.resolved && <Chip size="small" variant="outlined" label={scenarioTexts.check.resolved} title={scenarioTexts.check.resolvedHint} />}
            <Typography variant="body2" color="text.secondary">
              {scenarioTexts.check.groups[issue.group]}
            </Typography>
            <Typography
              variant="body2"
              fontWeight={600}
              color={closed ? 'text.secondary' : undefined}
              sx={{ overflowWrap: 'anywhere', textDecoration: closed ? 'line-through' : undefined }}
            >
              {issue.title}
            </Typography>
            {issue.shots.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                {issue.shots.join(', ')}
              </Typography>
            )}
          </Stack>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5}>
            {issue.fixed && <Alert severity="success">{scenarioTexts.check.fixedHint}</Alert>}
            {issue.resolved && <Alert severity="info">{scenarioTexts.check.resolvedHint}</Alert>}
            <IssueText label={scenarioTexts.check.problem} text={issue.problem} />
            <IssueText label={scenarioTexts.check.why} text={issue.why} />
            <IssueText label={scenarioTexts.check.fix} text={issue.fix} />
            {issue.entities.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                {scenarioTexts.check.entities({ names: issue.entities.map(entityName).join(', ') })}
              </Typography>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {canFix && (
                <ActionButton
                  size="small"
                  variant="contained"
                  startIcon={<AutoFixHighIcon />}
                  disabled={!!fixReason}
                  disabledReason={fixReason}
                  title={scenarioTexts.check.fixHint}
                  onClick={onFix}
                >
                  {scenarioTexts.check.fixButton}
                </ActionButton>
              )}
              {!closed && !issue.changes.length && (
                <AgentButton
                  size="small"
                  variant="outlined"
                  disabled={!!reviseReason || !issue.shots.length}
                  disabledReason={reviseReason ?? scenarioTexts.check.reviseNoShots}
                  title={scenarioTexts.check.reviseHint}
                  onClick={onRevise}
                >
                  {scenarioTexts.check.revise}
                </AgentButton>
              )}
              {issue.shots.map((shot) => (
                <ActionButton
                  key={shot}
                  size="small"
                  variant="outlined"
                  startIcon={<ArrowForwardIcon />}
                  title={scenarioTexts.check.openShotHint({ shot })}
                  onClick={() => onOpenShot(shot, issue)}
                >
                  {scenarioTexts.check.openShot({ shot })}
                </ActionButton>
              ))}
              {!issue.fixed && (
                <ActionButton
                  size="small"
                  startIcon={issue.resolved ? <UndoIcon /> : <TaskAltIcon />}
                  disabled={!!resolveReason}
                  disabledReason={resolveReason}
                  title={issue.resolved ? scenarioTexts.check.unresolveHint : scenarioTexts.check.resolveHint}
                  onClick={() => onResolve(!issue.resolved)}
                >
                  {issue.resolved ? scenarioTexts.check.unresolve : scenarioTexts.check.resolve}
                </ActionButton>
              )}
            </Stack>
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

function IssueText({ label, text }: { label: string; text: string }): ReactElement {
  return (
    <Box>
      <Typography variant="subtitle2" component="div">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {text}
      </Typography>
    </Box>
  );
}
