/** Обложка использует отдельную временную попытку; показ цены отделён от единственной платной отправки. */
import { join } from 'node:path';
import type { CoverGenerationSession } from '@shared/cover-generation';
import { MEDIA_PROVIDERS, sameMediaProvider, type MediaModel } from '@shared/media-providers';
import { canAgreeToUnknownCost, priceAllowsGeneration } from '@shared/generation-consent';
import { readProjectSettings } from './checks';
import type { CoverCandidateInput, PreparedCoverCandidate } from './cover-generation';
import { selectPaidRequest, type PaidMediaProvider, type PreparePaidInput } from './media-providers';
import type { PaidRequestRules } from './providers/types';
import type { PythonLauncher } from './python-launcher';

export interface PaidCoverOptions {
  provider: Pick<PaidMediaProvider, 'adapter' | 'capabilities' | 'prepare' | 'submit' | 'collect'>;
  launcher: () => Pick<PythonLauncher, 'run'>;
  pricingArgs?: () => string[];
}
type Quote = NonNullable<CoverGenerationSession['quote']>;

function checkAbort(signal: AbortSignal, title: string, submitted = false): void {
  if (signal.aborted)
    throw new Error(
      submitted
        ? `Получение обложки остановлено. Запрос мог быть отправлен в ${title}; отмена ожидания не возвращает кредиты.`
        : 'Подготовка или генерация обложки остановлена. Отправка не выполнялась.'
    );
}

/** Объявленные синонимы раскрываются общим селектором; неподдерживаемые значения не заменяются догадкой. */
function parametersForModel(
  rules: PaidRequestRules,
  defaultResolution: string | undefined,
  model: MediaModel,
  options: Record<string, unknown>,
  resolution?: string
): Record<string, unknown> {
  const parameters = { ...options };
  const aliases = rules.aliases.image ?? {};
  // Пропорции и число кадров сцены не относятся к обложке: её назначение всегда одно квадратное изображение.
  for (const key of [...(aliases.aspect_ratio ?? ['aspect_ratio']), ...rules.outputCount]) delete parameters[key];
  parameters.aspect_ratio = '1:1';
  const resolutionKeys = aliases.resolution ?? ['resolution'];
  const suppliedResolutions = resolutionKeys.filter((key) => key in parameters);
  if (resolution !== undefined) {
    for (const key of suppliedResolutions) {
      if (parameters[key] !== resolution) throw new Error('Разрешение обложки конфликтует с явной настройкой generation.image.resolution.');
      delete parameters[key];
    }
    parameters.resolution = resolution;
  } else if (!suppliedResolutions.length && resolutionKeys.some((key) => key in model.arguments)) {
    parameters.resolution = defaultResolution;
  }
  const series = rules.image.series;
  if (series) {
    if (series.names.some((name) => parameters[name] === true || parameters[name] === 'true'))
      throw new Error(`Для обложки нужен обычный режим без серии ${series.names[0]}.`);
    const declared = series.names.find((key) => key in model.arguments);
    if (declared && !series.names.some((name) => name in parameters)) parameters[declared] = series.off;
  }
  return parameters;
}

export async function preparePaidCover(input: CoverCandidateInput, options: PaidCoverOptions): Promise<PreparedCoverCandidate> {
  const adapter = options.provider.adapter;
  const info = MEDIA_PROVIDERS[adapter.id];
  const title = info.title;
  checkAbort(input.signal, title);
  const settings = readProjectSettings(input.project).generation?.image;
  if (!settings || !sameMediaProvider(settings.provider, adapter.id)) throw new Error(`Выберите ${title} для изображений в настройках проекта.`);
  const capabilities = await options.provider.capabilities(input.project);
  checkAbort(input.signal, title);
  const request: PreparePaidInput = {
    project: input.project,
    workDir: join(input.workDir, 'request'),
    shot: 'M00',
    kind: 'image',
    command: adapter.rules.image.command(0),
    model: settings.model?.trim() ?? '',
    preferredModel: settings.model?.trim() || null,
    prompt: input.prompt,
    parameters: {},
    inputs: [],
    outputs: 1
  };
  const selected = selectPaidRequest(adapter, request, capabilities, (model) =>
    parametersForModel(adapter.rules, info.defaults.image?.resolution, model, settings.options ?? {}, settings.resolution)
  );
  const prepared = await options.provider.prepare(selected, capabilities);
  checkAbort(input.signal, title);

  const price = async (signal: AbortSignal): Promise<Quote> => {
    checkAbort(signal, title);
    try {
      const result = await options
        .launcher()
        .run(input.project, 'cost_check', ['check', '--work-dir', prepared.requestDir, '--json', ...(options.pricingArgs?.() ?? [])], {
          signal
        });
      checkAbort(signal, title);
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
      checkAbort(signal, title);
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Сбой проверки цены оставляет пользователю явный выбор; сам по себе он не разрешает отправку.
      return { credits: null, balance: null, verdict: 'cost_or_balance_unknown', message: `Не удалось получить стоимость и остаток кредитов ${title}.` };
    }
  };
  const quote = Object.freeze(await price(input.signal));
  let used = false;
  return {
    provider: adapter.id,
    model: selected.model,
    requestSha: prepared.requestSha,
    quote,
    async generate(signal, approval) {
      checkAbort(signal, title);
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
      checkAbort(signal, title);
      let submitted = false;
      try {
        await options.provider.submit(prepared, async (action, reference) => {
          if (action !== 'submit') throw new Error('Ожидалась единственная отправка подготовленного запроса.');
          checkAbort(signal, title);
          // После старта submit исход может быть неизвестен: отмена не разрешает повторный платный запрос.
          submitted = true;
          const result = await options
            .launcher()
            .run(input.project, 'media_request', ['submit', '--work-dir', reference.requestDir, '--confirm', reference.requestSha], {
              signal
            });
          checkAbort(signal, title, submitted);
          if (result.code !== 0) throw new Error(result.stderr.trim() || 'Не удалось отправить обложку. Повторная отправка этой попытки запрещена.');
        });
        checkAbort(signal, title, submitted);
        const result = await options.launcher().run(input.project, 'media_request', ['watch', '--work-dir', prepared.requestDir, '--max-minutes', '15'], {
          signal,
          timeoutMs: 15 * 60 * 1000
        });
        checkAbort(signal, title, submitted);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'Обложка ещё не получена. Запрос мог быть оплачен; повторная отправка не выполнялась.');
        // Фактическое списание запоминается: если сервис не сообщает цену заранее, такой же запрос в следующий раз покажет цену.
        await options
          .launcher()
          .run(input.project, 'cost_check', ['learn', '--work-dir', prepared.requestDir, ...(options.pricingArgs?.() ?? [])], { signal })
          .catch(() => undefined);
        const artifacts = options.provider.collect(prepared);
        if (artifacts.length !== 1 || artifacts[0].kind !== 'image') throw new Error(`${title} должен вернуть ровно одно изображение обложки.`);
        return { path: artifacts[0].path };
      } catch (error) {
        checkAbort(signal, title, submitted);
        throw error;
      }
    }
  };
}
