/** Обложка использует отдельную временную попытку; показ цены отделён от единственной платной отправки. */
import { join } from 'node:path';
import type { CoverGenerationSession } from '@shared/cover-generation';
import type { MediaModel } from '@shared/media-providers';
import { DEFAULT_KLING_IMAGE_GENERATION } from '@shared/types';
import { canAgreeToUnknownCost, priceAllowsGeneration } from '@shared/generation-consent';
import { readProjectSettings } from './checks';
import type { CoverCandidateInput, PreparedCoverCandidate } from './cover-generation';
import { selectKlingRequest, type KlingImageProvider, type PrepareKlingInput } from './media-providers';
import type { PythonLauncher } from './python-launcher';

export interface CoverKlingOptions {
  provider: Pick<KlingImageProvider, 'capabilities' | 'prepare' | 'submit' | 'collect'>;
  launcher: () => Pick<PythonLauncher, 'run'>;
  cliArgs: () => string[];
  pricingArgs?: () => string[];
}
type Quote = NonNullable<CoverGenerationSession['quote']>;

function checkAbort(signal: AbortSignal, submitted = false): void {
  if (signal.aborted)
    throw new Error(
      submitted
        ? 'Получение обложки остановлено. Запрос мог быть отправлен в Kling; отмена ожидания не возвращает кредиты.'
        : 'Подготовка или генерация обложки остановлена. Отправка не выполнялась.'
    );
}

/** Объявленные aliases раскрываются общим селектором; неподдерживаемые значения не заменяются догадкой. */
function parametersForModel(model: MediaModel, options: Record<string, unknown>, resolution?: string): Record<string, unknown> {
  const parameters = { ...options };
  // Пропорции и число кадров сцены не относятся к обложке: её назначение всегда одно квадратное изображение.
  for (const key of ['aspect_ratio', 'aspectRatio', 'image_count', 'imageCount']) delete parameters[key];
  parameters.aspect_ratio = '1:1';
  const resolutionKeys = ['resolution', 'img_resolution', 'imgResolution'];
  const suppliedResolutions = resolutionKeys.filter((key) => key in parameters);
  if (resolution !== undefined) {
    for (const key of suppliedResolutions) {
      if (parameters[key] !== resolution) throw new Error('Разрешение обложки конфликтует с явной настройкой generation.image.resolution.');
      delete parameters[key];
    }
    parameters.resolution = resolution;
  } else if (!suppliedResolutions.length && resolutionKeys.some((key) => key in model.arguments)) {
    parameters.resolution = DEFAULT_KLING_IMAGE_GENERATION.resolution;
  }
  if ([parameters.story_mode, parameters.storyMode].some((value) => value === true || value === 'true'))
    throw new Error('Для обложки нужен обычный режим без серии story_mode.');
  const storyMode = ['story_mode', 'storyMode'].find((key) => key in model.arguments);
  if (storyMode && !('story_mode' in parameters) && !('storyMode' in parameters)) parameters[storyMode] = false;
  return parameters;
}

export async function prepareKlingCover(input: CoverCandidateInput, options: CoverKlingOptions): Promise<PreparedCoverCandidate> {
  checkAbort(input.signal);
  const settings = readProjectSettings(input.project).generation?.image;
  if (settings?.provider !== 'kling') throw new Error('Выберите Kling для изображений в настройках проекта.');
  const capabilities = await options.provider.capabilities(input.project);
  checkAbort(input.signal);
  const request: PrepareKlingInput = {
    project: input.project,
    workDir: join(input.workDir, 'request'),
    shot: 'M00',
    kind: 'image',
    command: 'text_to_image',
    model: settings.model?.trim() ?? '',
    preferredModel: settings.model?.trim() || null,
    prompt: input.prompt,
    parameters: {},
    inputs: [],
    outputs: 1
  };
  const selected = selectKlingRequest(request, capabilities, (model) => parametersForModel(model, settings.options ?? {}, settings.resolution));
  const prepared = await options.provider.prepare(selected, capabilities);
  checkAbort(input.signal);

  const price = async (signal: AbortSignal): Promise<Quote> => {
    checkAbort(signal);
    try {
      const result = await options
        .launcher()
        .run(input.project, 'cost_check', ['check', '--work-dir', prepared.requestDir, '--json', ...options.cliArgs(), ...(options.pricingArgs?.() ?? [])], {
          signal
        });
      checkAbort(signal);
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const value = parsed as Record<string, unknown>;
      if (![0, 2].includes(result.code ?? -1) || !['ok', 'insufficient_balance', 'cost_or_balance_unknown'].includes(String(value.verdict))) throw new Error();
      const credits = typeof value.estimate_credits === 'number' && Number.isFinite(value.estimate_credits) ? value.estimate_credits : null;
      const balance = typeof value.balance_credits === 'number' && Number.isFinite(value.balance_credits) ? value.balance_credits : null;
      if ((credits !== null && credits < 0) || (balance !== null && balance < 0)) throw new Error();
      if (value.verdict === 'ok' && (result.code !== 0 || credits === null || balance === null || balance < credits)) throw new Error();
      const reasons = Array.isArray(value.reasons) ? value.reasons.filter((item): item is string => typeof item === 'string') : [];
      return { credits, balance, verdict: value.verdict as Quote['verdict'], ...(reasons.length ? { message: reasons.join(' ') } : {}) };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Сбой проверки цены оставляет пользователю явный выбор; сам по себе он не разрешает отправку.
      return { credits: null, balance: null, verdict: 'cost_or_balance_unknown', message: 'Не удалось получить стоимость и остаток кредитов Kling.' };
    }
  };
  const quote = Object.freeze(await price(input.signal));
  let used = false;
  return {
    provider: 'kling',
    model: selected.model,
    requestSha: prepared.requestSha,
    quote,
    async generate(signal, approval) {
      checkAbort(signal);
      if (used) throw new Error('Эта попытка уже запускалась. Для новой генерации подготовьте и подтвердите новый запрос.');
      used = true;
      if (!priceAllowsGeneration(quote, approval?.allowUnknownCost === true))
        throw new Error('Стоимость или остаток не подтверждены. Подготовьте запрос и подтвердите цену либо согласие на неизвестную стоимость.');
      const current = await price(signal);
      // Согласие на неизвестную цену допускает появление цены перед отправкой, но не нехватку средств.
      const approvedUnknownCost = canAgreeToUnknownCost(quote) && approval?.allowUnknownCost === true;
      const currentApproved = approvedUnknownCost
        ? priceAllowsGeneration(current, true)
        : current.verdict === 'ok' && current.credits === quote.credits && current.balance === quote.balance;
      if (!currentApproved) throw new Error('Стоимость или остаток изменились. Подготовьте запрос и подтвердите цену заново; отправка не выполнялась.');
      checkAbort(signal);
      let submitted = false;
      try {
        await options.provider.submit(prepared, async (action, reference) => {
          if (action !== 'submit') throw new Error('Ожидалась единственная отправка подготовленного запроса.');
          checkAbort(signal);
          // После старта submit исход может быть неизвестен: отмена не разрешает повторный платный запрос.
          submitted = true;
          const result = await options
            .launcher()
            .run(input.project, 'kling_request', ['submit', '--work-dir', reference.requestDir, '--confirm', reference.requestSha, ...options.cliArgs()], {
              signal
            });
          checkAbort(signal, submitted);
          if (result.code !== 0) throw new Error(result.stderr.trim() || 'Не удалось отправить обложку. Повторная отправка этой попытки запрещена.');
        });
        checkAbort(signal, submitted);
        const result = await options
          .launcher()
          .run(input.project, 'kling_request', ['watch', '--work-dir', prepared.requestDir, '--max-minutes', '15', ...options.cliArgs()], {
            signal,
            timeoutMs: 15 * 60 * 1000
          });
        checkAbort(signal, submitted);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'Обложка ещё не получена. Запрос мог быть оплачен; повторная отправка не выполнялась.');
        const artifacts = options.provider.collect(prepared);
        if (artifacts.length !== 1 || artifacts[0].kind !== 'image') throw new Error('Kling должен вернуть ровно одно изображение обложки.');
        return { path: artifacts[0].path };
      } catch (error) {
        checkAbort(signal, submitted);
        throw error;
      }
    }
  };
}
