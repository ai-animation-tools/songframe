import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Paper, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import ComputerIcon from '@mui/icons-material/Computer';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MicIcon from '@mui/icons-material/Mic';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import AbcIcon from '@mui/icons-material/Abc';
import type { ComponentState, ComponentPackage as InstallPackage } from '@shared/components';
import { componentTexts as text } from '@shared/texts/component-manager';
import { ActionButton } from '../../../components/ActionButton';
import ffmpegLogo from '../../../assets/components/ffmpeg.ico';
import onnxRuntimeLogo from '../../../assets/components/onnx-runtime.svg';

/** Размер загрузки берётся из закреплённого manifest; страница не делает сетевых запросов для оценки. */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} ${text.units.bytes}`;
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${text.units.kibibytes}`;
  return `${(value / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${text.units.mebibytes}`;
}

/** Download сам исправляет непригодное подключение; готовые/найденные файлы не скачиваются повторно. */
export function componentNeedsDownload(state: ComponentState | undefined): boolean {
  return !!state && ['missing', 'error', 'incompatible', 'cancelled'].includes(state.status);
}

/** Прокрутка к зависимости сохраняет текущий hash-маршрут Wails и переносит клавиатурный фокус. */
function showRuntime() {
  const target = document.getElementById('component-ort-cpu');
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  target?.focus({ preventScroll: true });
}

/** Состояние объясняется без технических имён файлов; исходная причина доступна в сведениях компонента. */
function statusDescription(status: string, checking: boolean, purpose: string): string {
  if (status === 'blocked') return text.waitingForRuntime;
  if (status === 'restart_required') return text.restartHint;
  if (status === 'unchecked') return checking ? text.preparing : text.changedConnection;
  if (status === 'error') return text.componentError;
  if (status === 'incompatible') return text.incompatibleHint;
  if (status === 'cancelled') return text.cancelledHint;
  return purpose;
}

/** Карточка предлагает только скачать отсутствующее или выбрать компонент на компьютере.
 * Подробности и смена готового подключения используют штатный MUI Accordion.
 */
export function ComponentCard({
  item,
  state,
  busy,
  checking,
  highlighted,
  onDownload,
  onConnect
}: {
  item: InstallPackage;
  state?: ComponentState;
  busy: boolean;
  checking: boolean;
  highlighted: boolean;
  onDownload: () => void;
  onConnect: () => void;
}) {
  const status = state?.status ?? 'missing';
  const ready = status === 'ready';
  const pending = status === 'unchecked' && checking;
  const waiting = status === 'blocked';
  const downloadable = item.supported && componentNeedsDownload(state);
  const primaryConnection = !ready && !pending && status !== 'restart_required';
  const failure = ['error', 'incompatible', 'restart_required', 'cancelled'].includes(status);
  const logo = item.component === 'ffmpeg' ? ffmpegLogo : item.component === 'ort-cpu' ? onnxRuntimeLogo : null;
  const icon = item.component === 'voc-ft' ? <MicIcon /> : item.component === 'ctc-ru' ? <GraphicEqIcon /> : <AbcIcon />;
  // Paths может содержать расчётные entrypoints, в том числе при ошибке профиля.
  // Расположение показываем только для состояний с подтверждённым обнаружением файлов.
  const hasLocatedFiles = ['ready', 'blocked', 'unchecked', 'restart_required'].includes(status);
  const path = hasLocatedFiles
    ? Object.values(state?.paths ?? {})
        .filter(Boolean)
        .join('\n')
    : '';
  const title = text.names[item.component] ?? item.component;
  const connect = (
    <ActionButton startIcon={<ComputerIcon />} onClick={onConnect} disabled={busy} disabledReason={text.working}>
      {text.chooseOnComputer}
    </ActionButton>
  );
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-label={title}
      id={`component-${item.component}`}
      tabIndex={-1}
      sx={{ p: 2, minWidth: 0, scrollMarginTop: 140, borderColor: highlighted ? 'primary.main' : 'divider' }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Box
            aria-hidden="true"
            sx={{
              width: 56,
              height: 56,
              flexShrink: 0,
              borderRadius: 2,
              bgcolor: 'action.hover',
              display: 'grid',
              placeItems: 'center',
              color: 'primary.main',
              '& svg': { fontSize: 32 }
            }}
          >
            {logo ? <Box component="img" src={logo} alt="" sx={{ width: 40, height: 40, objectFit: 'contain' }} /> : icon}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" component="h2" sx={{ lineHeight: 1.25, mb: 0.75 }}>
              {title}
            </Typography>
            <Chip
              size="small"
              label={text.statuses[pending ? 'checking' : status] ?? status}
              color={ready ? 'success' : waiting ? 'warning' : failure ? 'error' : 'default'}
            />
          </Box>
        </Stack>
        <Typography variant="body2">{statusDescription(status, checking, text.purposes[item.component] ?? '')}</Typography>
        {waiting && (
          <Box>
            <ActionButton startIcon={<ArrowForwardIcon />} onClick={showRuntime}>
              {text.openRequired}
            </ActionButton>
          </Box>
        )}
        {downloadable && (
          <Stack direction="row" gap={1.25} alignItems="center" flexWrap="wrap">
            <ActionButton variant="contained" startIcon={<DownloadIcon />} onClick={onDownload} disabled={busy} disabledReason={text.working}>
              {text.install}
            </ActionButton>
            <Typography variant="body2" color="text.secondary">
              {text.approximateSize(formatBytes(item.bytes))}
            </Typography>
          </Stack>
        )}
        {primaryConnection && <Box>{connect}</Box>}
        <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}>
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            sx={{ px: 0, minHeight: 32, color: 'text.secondary', '& .MuiAccordionSummary-content': { my: 0.5 } }}
          >
            <Typography variant="body2">{ready ? text.changeConnection : text.details}</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0, pt: 1, pb: 0 }}>
            <Stack spacing={1.5}>
              {!primaryConnection && connect}
              <Typography variant="body2" color="text.secondary">
                {text.connectionHint}
              </Typography>
              {path && (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                  {text.path}: {path}
                </Typography>
              )}
              {state?.version && ['ffmpeg', 'ort-cpu'].includes(item.component) && (
                <Typography variant="body2">
                  {text.version}: {state.version}
                </Typography>
              )}
              {failure && state?.reason && (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {state.reason}
                </Typography>
              )}
              {item.license && (
                <Typography variant="body2">
                  {text.license}: {item.license}
                </Typography>
              )}
            </Stack>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Paper>
  );
}
