import { productionTexts } from '@shared/texts/production';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FitScreenIcon from '@mui/icons-material/FitScreen';
/**
 * Параметры переноса результата в assets с сохранением выбранного монтажного участка. У участка —
 * итог: сколько кадров получится в плане при скорости и удержании и совпадает ли это с окном плана
 * (счёт тот же, что у Go, — cutResultFrames), чтобы несовпадение было видно до «Принять».
 * «Подогнать конец под окно» подставляет конец, при котором план совпадёт с окном (fitCutEnd).
 * «Показать участок под песню» собирает участок так, как его примет приёмка (CutPreviewPanel).
 * «Скорость по частям» заменяет одну скорость частями со своими скоростями: концы частей — секунды
 * оригинала, последняя часть кончается концом участка и следует за ним; итог и подгонка конца
 * считают части по отдельности (partsResultFrames), подгонка двигает конец последней части.
 */
import type { ReactElement } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, IconButton, MenuItem, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { AcceptOptions, AcceptSpeedPart, CutPreview } from '@shared/types';
import type { AcceptTarget } from '../decisions';
import { cutFrameOf, cutResultFrames, cutSeconds, DEFAULT_FPS, fitCutEnd, partsResultFrames } from '@shared/video';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { CutPreviewPanel } from './CutPreviewPanel';

export function AcceptResultDialog({
  target,
  options,
  onOptions,
  onClose,
  onConfirm,
  onPreview,
  kind = 'accept'
}: {
  target: AcceptTarget | null;
  options: AcceptOptions;
  onOptions(value: AcceptOptions): void;
  onClose(): void;
  onConfirm(): void;
  /** Предпросмотр участка (production.cutPreview); без него кнопки предпросмотра нет. */
  onPreview?(options: AcceptOptions): Promise<CutPreview>;
  /** accept — приёмка результата попытки; recut — новый участок уже принятого плана из оригинала комплекта. */
  kind?: 'accept' | 'recut';
}): ReactElement {
  const recut = kind === 'recut';
  const durationMismatch = !!target?.windowFrames && !!target.originalFrames && target.windowFrames !== target.originalFrames;
  // Другой кадр или частота оригинала тоже закрывают «целиком»: видео приводится к кадру проекта участком.
  const frameMismatch = target?.frameMismatch;
  const mismatch = durationMismatch || !!frameMismatch;
  // Без открытого диалога (target null) шкала не используется; DEFAULT_FPS лишь держит расчёт определённым.
  const fps = target?.fps ?? DEFAULT_FPS;
  const seconds = (frames?: number): string => ((frames ?? 0) / fps).toFixed(2).replace('.', ',');
  // Граница участка вводится секундами до тысячных; стрелки поля шагают на кадр и тоже округляются.
  const thousandths = (value: string): number => Math.round(Number(value) * 1000) / 1000;
  // Подсказка под границей: кадр сетки проекта или соседние кадры, если граница между ними.
  const boundary = (value: number): { helperText: string; error: boolean } => {
    const frame = cutFrameOf(value, fps);
    if (frame !== null) return { helperText: productionTexts.acceptResultDialog.cutFrame({ frame }), error: false };
    const before = Math.max(0, Math.floor(value * fps));
    const text = (index: number): string => String(cutSeconds(index, fps)).replace('.', ',');
    return { helperText: productionTexts.acceptResultDialog.cutBetween({ before: text(before), after: text(before + 1) }), error: true };
  };
  // Части скорости: последняя часть всегда кончается концом участка.
  const parts: AcceptSpeedPart[] | null = options.speedParts?.length
    ? options.speedParts.map((part, index, list) => (index === list.length - 1 ? { ...part, end: options.cutEnd ?? 0 } : part))
    : null;
  const withParts = (next: AcceptSpeedPart[]): AcceptOptions => ({ ...options, speed: undefined, speedParts: next });
  const setCutEnd = (end: number): AcceptOptions =>
    parts
      ? { ...options, cutEnd: end, speedParts: parts.map((part, index) => (index === parts.length - 1 ? { ...part, end } : part)) }
      : { ...options, cutEnd: end };
  const partFrames = (list: AcceptSpeedPart[]) => list.map((part) => ({ endFrame: cutFrameOf(part.end, fps), speed: part.speed }));
  // Включение частей делит участок пополам с прежней скоростью; выключение оставляет скорость первой части.
  const toggleParts = (on: boolean): void => {
    if (!on) {
      onOptions({ ...options, speed: parts?.[0]?.speed ?? '1', speedParts: undefined });
      return;
    }
    const start = cutFrameOf(options.cutStart ?? 0, fps) ?? 0;
    const end = cutFrameOf(options.cutEnd ?? 0, fps) ?? start;
    const speed = options.speed ?? '1';
    onOptions(
      withParts([
        { end: cutSeconds(Math.floor((start + end) / 2), fps), speed },
        { end: options.cutEnd ?? 0, speed }
      ])
    );
  };
  // Новая часть делит последнюю пополам; у неё та же скорость.
  const addPart = (): void => {
    if (!parts) return;
    const last = parts[parts.length - 1];
    const from = cutFrameOf(parts.length > 1 ? parts[parts.length - 2].end : (options.cutStart ?? 0), fps) ?? 0;
    const to = cutFrameOf(last.end, fps) ?? from;
    onOptions(withParts([...parts.slice(0, -1), { end: cutSeconds(Math.floor((from + to) / 2), fps), speed: last.speed }, last]));
  };
  // Итог участка, как его посчитает Go: сколько кадров получится в плане и совпадает ли с окном.
  const result = (): { severity: 'success' | 'warning' | 'info' | 'error'; text: string } => {
    const texts = productionTexts.acceptResultDialog;
    const frames = parts
      ? partsResultFrames(cutFrameOf(options.cutStart ?? 0, fps), partFrames(parts), options.holdFirst ?? 0, options.holdLast ?? 0)
      : cutResultFrames(
          cutFrameOf(options.cutStart ?? 0, fps),
          cutFrameOf(options.cutEnd ?? 0, fps),
          options.speed ?? '1',
          options.holdFirst ?? 0,
          options.holdLast ?? 0
        );
    if (frames === null) return { severity: 'error', text: texts.cutResultInvalid };
    const length = { frames, seconds: seconds(frames) };
    const window = target?.windowFrames;
    if (!window) return { severity: 'info', text: texts.cutResultLength(length) };
    if (frames === window) return { severity: 'success', text: texts.cutResultFit(length) };
    return frames < window
      ? { severity: 'warning', text: texts.cutResultShort({ frames, window, missing: window - frames }) }
      : { severity: 'warning', text: texts.cutResultLong({ frames, window, extra: frames - window }) };
  };
  const cutResult = options.mode === 'cut' ? result() : null;
  // Конец участка под окно плана: новое значение поля или причина, почему его не подобрать.
  const fit = (): { end: number; reason: null } | { end: null; reason: string } => {
    const texts = productionTexts.acceptResultDialog;
    if (!target?.windowFrames) return { end: null, reason: texts.fitEndNoWindow };
    // С частями подгоняется последняя часть: окну остаётся то, что не заняли предыдущие части.
    let from = cutFrameOf(options.cutStart ?? 0, fps);
    let speed = options.speed ?? '1';
    let window = target.windowFrames;
    if (parts) {
      const before = parts.slice(0, -1);
      const taken = before.length > 1 ? partsResultFrames(from, partFrames(before)) : cutResultFrames(from, cutFrameOf(before[0].end, fps), before[0].speed);
      if (taken === null) return { end: null, reason: texts.fitEndInvalid };
      from = cutFrameOf(before[before.length - 1].end, fps);
      speed = parts[parts.length - 1].speed;
      window -= taken;
    }
    const fitted = fitCutEnd(from, speed, window, options.holdFirst ?? 0, options.holdLast ?? 0, target.originalFrames);
    if ('endFrame' in fitted) return { end: cutSeconds(fitted.endFrame, fps), reason: null };
    if (fitted.reason === 'holdsTooLong') return { end: null, reason: parts ? texts.fitEndParts : texts.fitEndHolds };
    if (fitted.reason === 'originalTooShort')
      return { end: null, reason: texts.fitEndOriginal({ needed: seconds(fitted.neededFrames), original: seconds(target.originalFrames) }) };
    return { end: null, reason: texts.fitEndInvalid };
  };
  const fitted = options.mode === 'cut' ? fit() : null;
  // Предпросмотр всегда собирается участком: «целиком» — это участок во всё окно со скоростью 1.
  const previewOptions: AcceptOptions =
    options.mode === 'cut'
      ? {
          mode: 'cut',
          cutStart: options.cutStart,
          cutEnd: options.cutEnd,
          ...(parts ? { speedParts: parts } : { speed: options.speed ?? '1' }),
          holdFirst: options.holdFirst ?? 0,
          holdLast: options.holdLast ?? 0
        }
      : { mode: 'cut', cutStart: 0, cutEnd: cutSeconds(target?.windowFrames ?? 0, fps), speed: '1', holdFirst: 0, holdLast: 0 };
  const previewReason =
    !target?.windowFrames || (options.mode === 'cut' && cutResult?.severity !== 'success') ? productionTexts.acceptResultDialog.previewMismatch : null;
  return (
    <ConfirmationDialog
      open={!!target}
      explicitCancelOnly
      onClose={onClose}
      title={(recut ? productionTexts.acceptResultDialog.recutTitle : productionTexts.acceptResultDialog.title)({ shot: target?.shot ?? '' })}
      onConfirm={onConfirm}
      confirmLabel={
        recut
          ? productionTexts.acceptResultDialog.recutConfirm
          : target?.hasAsset
            ? productionTexts.acceptResultDialog.replace
            : productionTexts.acceptResultDialog.accept
      }
      confirmIcon={<CheckCircleIcon />}
      confirmColor="error"
      // У нового участка принятого плана источник — сам комплект: токена результата и согласия на замену нет.
      confirmDisabled={!recut && (!target?.resultToken || !!target?.speechMissing || (!!target?.hasAsset && !options.replaceExisting))}
      confirmDisabledReason={
        !target?.resultToken
          ? productionTexts.acceptResultDialog.resultUnconfirmed
          : target.speechMissing
            ? productionTexts.acceptResultDialog.speechRequired
            : productionTexts.acceptResultDialog.replacementRequired
      }
    >
      <Stack spacing={2} sx={{ mt: 1 }}>
        {target?.hasAsset ? <Alert severity="warning">{productionTexts.acceptResultDialog.replacementDescription({ shot: target.shot })}</Alert> : null}
        {target?.hasAsset ? (
          <FormControlLabel
            control={<Checkbox checked={!!options.replaceExisting} onChange={(e) => onOptions({ ...options, replaceExisting: e.target.checked })} />}
            label={productionTexts.acceptResultDialog.replaceCheckbox}
          />
        ) : null}
        {frameMismatch ? (
          <Alert severity="info">
            {productionTexts.acceptResultDialog.frameMismatch({
              width: frameMismatch.width,
              height: frameMismatch.height,
              rate: frameRateText(frameMismatch.frameRate),
              fps
            })}
          </Alert>
        ) : durationMismatch ? (
          <Alert severity="info">
            {productionTexts.acceptResultDialog.durationMismatch({
              originalSeconds: seconds(target?.originalFrames),
              windowSeconds: seconds(target?.windowFrames),
              holdLast: target && target.originalFrames! < target.windowFrames!
            })}
          </Alert>
        ) : null}
        {recut ? null : (
          <TextField
            select
            size="small"
            label={productionTexts.acceptResultDialog.section}
            value={options.mode}
            onChange={(e) => {
              const mode = e.target.value as AcceptOptions['mode'];
              // Оригинал целиком берётся без изменения скорости: части к нему не относятся.
              onOptions(mode === 'full' ? { ...options, mode, speed: parts?.[0]?.speed ?? options.speed, speedParts: undefined } : { ...options, mode });
            }}
          >
            <MenuItem value="full" disabled={mismatch}>
              {productionTexts.acceptResultDialog.full}
            </MenuItem>
            <MenuItem value="cut">{productionTexts.acceptResultDialog.cut}</MenuItem>
          </TextField>
        )}
        {options.mode === 'cut' ? (
          // Две колонки оставляют место полной подписи удержания кадра и её единице измерения.
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 1 }}>
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.cutStart}
              value={options.cutStart}
              onChange={(e) => onOptions({ ...options, cutStart: thousandths(e.target.value) })}
              inputProps={{ step: 1 / fps }}
              {...boundary(options.cutStart ?? 0)}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.cutEnd}
              value={options.cutEnd}
              onChange={(e) => onOptions(setCutEnd(thousandths(e.target.value)))}
              inputProps={{ step: 1 / fps }}
              {...boundary(options.cutEnd ?? 0)}
            />
            {parts ? null : (
              <TextField
                size="small"
                label={productionTexts.acceptResultDialog.speed}
                value={options.speed}
                // Запятая — привычная русская запись дроби; Go разбирает множитель только с точкой.
                onChange={(e) => onOptions({ ...options, speed: e.target.value.replace(',', '.') })}
                helperText={productionTexts.acceptResultDialog.speedHint}
              />
            )}
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.holdFirst}
              value={options.holdFirst ?? 0}
              onChange={(e) => onOptions({ ...options, holdFirst: Number(e.target.value) })}
              inputProps={{ min: 0, step: 1 }}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.holdLast}
              value={options.holdLast ?? 0}
              onChange={(e) => onOptions({ ...options, holdLast: Number(e.target.value) })}
              inputProps={{ min: 0, step: 1 }}
            />
          </Box>
        ) : null}
        {options.mode === 'cut' ? (
          <Box>
            <FormControlLabel
              control={<Switch checked={!!parts} onChange={(event) => toggleParts(event.target.checked)} />}
              label={productionTexts.acceptResultDialog.speedParts}
            />
            <Typography variant="body2" color="text.secondary">
              {productionTexts.acceptResultDialog.speedPartsHint}
            </Typography>
            {parts ? (
              <Stack spacing={1} sx={{ mt: 1 }} data-testid="accept-speed-parts">
                {parts.map((part, index) => {
                  const last = index === parts.length - 1;
                  const texts = productionTexts.acceptResultDialog;
                  return (
                    <Stack key={index} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                      {last ? (
                        <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 0', minWidth: 0, pt: 1 }}>
                          {texts.partLast({ end: String(part.end).replace('.', ',') })}
                        </Typography>
                      ) : (
                        <TextField
                          size="small"
                          type="number"
                          label={texts.partEnd({ index: index + 1 })}
                          value={part.end}
                          onChange={(e) => onOptions(withParts(parts.map((item, at) => (at === index ? { ...item, end: thousandths(e.target.value) } : item))))}
                          inputProps={{ step: 1 / fps }}
                          sx={{ flex: '1 1 0' }}
                          {...boundary(part.end)}
                        />
                      )}
                      <TextField
                        size="small"
                        label={texts.partSpeed({ index: index + 1 })}
                        value={part.speed}
                        onChange={(e) =>
                          onOptions(withParts(parts.map((item, at) => (at === index ? { ...item, speed: e.target.value.replace(',', '.') } : item))))
                        }
                        helperText={texts.speedHint}
                        sx={{ flex: '1 1 0' }}
                      />
                      <Tooltip title={parts.length > 2 ? texts.removePart({ index: index + 1 }) : texts.partsMinimum}>
                        <span>
                          <IconButton
                            aria-label={texts.removePart({ index: index + 1 })}
                            disabled={parts.length <= 2}
                            onClick={() => {
                              // Убранная часть отдаёт свой отрезок следующей; у последней конец переходит предыдущей.
                              const next = parts.filter((_, at) => at !== index);
                              if (last) next[next.length - 1] = { ...next[next.length - 1], end: part.end };
                              onOptions(withParts(next));
                            }}
                          >
                            <DeleteOutlineIcon />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  );
                })}
                <Box>
                  <ActionButton size="small" startIcon={<AddIcon />} title={productionTexts.acceptResultDialog.addPartHint} onClick={addPart}>
                    {productionTexts.acceptResultDialog.addPart}
                  </ActionButton>
                </Box>
              </Stack>
            ) : null}
          </Box>
        ) : null}
        {fitted ? (
          <Box>
            <ActionButton
              size="small"
              variant="outlined"
              startIcon={<FitScreenIcon />}
              title={productionTexts.acceptResultDialog.fitEndHint}
              disabled={fitted.end === null}
              disabledReason={fitted.reason}
              onClick={() => fitted.end !== null && onOptions(setCutEnd(fitted.end))}
            >
              {productionTexts.acceptResultDialog.fitEnd}
            </ActionButton>
          </Box>
        ) : null}
        {cutResult ? (
          <Alert severity={cutResult.severity} data-testid="accept-cut-result">
            {cutResult.text}
          </Alert>
        ) : null}
        {target && onPreview ? (
          <CutPreviewPanel
            key={target.dir}
            parameters={JSON.stringify(previewOptions)}
            disabledReason={previewReason}
            fps={fps}
            onPreview={() => onPreview(previewOptions)}
          />
        ) : null}
        <Alert severity="info">{recut ? productionTexts.acceptResultDialog.recutConsequences : productionTexts.acceptResultDialog.consequences}</Alert>
      </Stack>
    </ConfirmationDialog>
  );
}

/** Частота ffprobe «30000/1001» — для человека «29,97»; неизвестная — «?». */
function frameRateText(rate: string): string {
  const [numerator, denominator = '1'] = rate.split('/');
  const value = Number(numerator) / Number(denominator);
  return Number.isFinite(value) && value > 0 ? String(Math.round(value * 100) / 100).replace('.', ',') : '?';
}
