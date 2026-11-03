/** Модель отправки проверяет снимок и одноразовую оценку; сервис и списание существуют только в памяти витрины. */
import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import EditIcon from '@mui/icons-material/Edit';
import type { Api } from '@shared/api';
import type { JobInfo, PackageView, ProductionQuote } from '@shared/types';
import { priceAllowsGeneration } from '@shared/generation-consent';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { SendRequestDialog } from '../pages/ProductionPage/components/SendRequestDialog';
import { sendConfirmedRequest } from '../pages/ProductionPage/decisions';
import { storyAccess } from './commonStories';
import { DELIVERY_PROJECT, deliveryJob, deliveryPackage, deliveryQuote } from './deliveryStories';
import { createStoryApi, type StoryOptions } from './storybook';

export interface SendRequestOptions {
  quote?: 'known' | 'unknown' | 'insufficient' | 'mismatch';
  quotePending?: boolean;
  failQuoteOnce?: boolean;
  failSubmitOnce?: boolean;
  submitPending?: boolean;
  missingSha?: boolean;
  offline?: boolean;
}

interface SendModel {
  package: PackageView;
  revision(): number;
  subscribe(listener: () => void): () => void;
  quotes: number;
  submissions: number;
  changeRequest(): void;
  reset(): void;
}
const models = new WeakMap<Api, SendModel>();

export function sendRequestOptions(options: SendRequestOptions = {}): StoryOptions {
  return {
    app: {
      aiAccess: options.offline
        ? { ...storyAccess, video: { ...storyAccess.video, available: false, message: 'Нет сети: восстановите соединение для отправки.' } }
        : storyAccess,
      online: !options.offline
    },
    createApi: () => {
      const listeners = new Set<() => void>();
      const pending = new Set<() => void>();
      const quotes = new Map<string, { quote: ProductionQuote; dir: string; decisionToken?: string }>();
      let disposed = false;
      let version = 0;
      // Номер токена не сбрасывается: старое согласие не может совпасть с новой оценкой после локального сброса.
      let tokenSequence = 0;
      const notify = (): void => {
        version++;
        listeners.forEach((listener) => listener());
      };
      const initial = (): PackageView => {
        const pkg = deliveryPackage('video', 'prepared');
        return options.missingSha ? { ...pkg, request: { ...pkg.request!, sha256: null } } : pkg;
      };
      const model: SendModel = {
        package: initial(),
        quotes: 0,
        submissions: 0,
        revision: () => version,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        changeRequest() {
          const pkg = model.package;
          model.package = {
            ...pkg,
            decisionToken: 'e'.repeat(64),
            request: { ...pkg.request!, sha256: 'f'.repeat(64), promptText: 'Камера отъезжает от ворот: новая версия запроса.' }
          };
          quotes.clear();
          notify();
        },
        reset() {
          model.package = initial();
          model.quotes = 0;
          model.submissions = 0;
          quotes.clear();
          notify();
        }
      };
      const validate = (project: string, dir: string, sha: string, decisionToken?: string): void => {
        if (
          disposed ||
          project !== DELIVERY_PROJECT ||
          dir !== model.package.dir ||
          sha !== model.package.request?.sha256 ||
          decisionToken !== model.package.decisionToken
        ) {
          throw new Error('Снимок запроса изменился: откройте актуальный пакет.');
        }
      };
      const waitPending = async (): Promise<void> => {
        await new Promise<void>((resolve) => pending.add(resolve));
      };
      const session = createStoryApi({
        production: {
          quote: async (project, dir, sha, decisionToken) => {
            validate(project, dir, sha, decisionToken);
            model.quotes++;
            notify();
            if (options.quotePending) await waitPending();
            if (disposed) throw new Error('История закрыта.');
            if (options.failQuoteOnce && model.quotes === 1) throw new Error('Не удалось получить оценку. Повторите проверку стоимости.');
            const quote = deliveryQuote(model.package, {
              token: `send-story-quote-${++tokenSequence}`,
              ...(options.quote === 'unknown' ? { credits: null, verdict: 'cost_or_balance_unknown' } : {}),
              ...(options.quote === 'insufficient' ? { balance: 2, verdict: 'insufficient_balance' } : {}),
              ...(options.quote === 'mismatch' ? { requestSha: '0'.repeat(64) } : {})
            });
            // Обновление оценки аннулирует прежний токен даже при неизменном SHA.
            quotes.clear();
            quotes.set(quote.token, { quote, dir, decisionToken });
            return quote;
          },
          submit: async (project, dir, sha, decisionToken, token, consent) => {
            validate(project, dir, sha, decisionToken);
            const stored = token ? quotes.get(token) : undefined;
            if (!stored || stored.dir !== dir || stored.decisionToken !== decisionToken || stored.quote.requestSha !== sha) {
              throw new Error('Оценка отсутствует или уже использована.');
            }
            if (consent && consent !== token) throw new Error('Согласие относится к другой оценке.');
            if (!priceAllowsGeneration(stored.quote, consent === token)) throw new Error('Стоимость текущего запроса не согласована.');
            // Неуспешная отправка тоже потребляет оценку: повтор требует новой проверки и согласия.
            quotes.delete(token!);
            model.submissions++;
            notify();
            if (options.submitPending) await waitPending();
            if (disposed) throw new Error('История закрыта.');
            if (options.failSubmitOnce && model.submissions === 1) throw new Error('Не удалось отправить запрос. Проверьте состояние пакета.');
            model.package = {
              ...model.package,
              stage: 'submitted',
              stageLabel: 'Запрос отправлен',
              pendingDecision: null,
              request: { ...model.package.request!, attemptStatus: 'submitted', generationId: 'demo-video-send-01' }
            };
            notify();
            return deliveryJob('submit', { title: 'Получение результата локального запроса' });
          }
        }
      });
      models.set(session.api, model);
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      session.onCleanup(() => {
        disposed = true;
        pending.forEach((resolve) => resolve());
        pending.clear();
        listeners.clear();
        quotes.clear();
        models.delete(session.api);
      });
      return session;
    }
  };
}

/** Родитель использует рабочее решение sendConfirmedRequest и отдельно показывает запуск получения результата. */
export function SendRequestStory({ busy = false }: { busy?: boolean }) {
  const model = models.get(window.api);
  if (!model) throw new Error('Для отправки нужна локальная API-сессия истории.');
  useSyncExternalStore(model.subscribe, model.revision);
  const [open, setOpen] = useState(true);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [epoch, setEpoch] = useState(0);
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Отправка подготовленного запроса M02</Typography>
      <Alert severity="info">Локальная демонстрация: запросы в сервис и списания не выполняются.</Alert>
      <Typography data-testid="send-counts">
        Проверок стоимости: {model.quotes}. Попыток отправки: {model.submissions}.
      </Typography>
      {job && <Alert severity="success">Запрос отправлен. Задание получения: {job.status}. Результат ещё не получен.</Alert>}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Button startIcon={<SendIcon />} onClick={() => setOpen(true)} disabled={!!job}>
          Открыть подтверждение
        </Button>
        <Button
          startIcon={<EditIcon />}
          disabled={!!job}
          onClick={() => {
            model.changeRequest();
            setOpen(true);
          }}
        >
          Открыть изменённый запрос
        </Button>
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => {
            model.reset();
            setJob(null);
            setOpen(true);
            setEpoch((value) => value + 1);
          }}
        >
          Сбросить модель
        </Button>
      </Stack>
      <SendRequestDialog
        key={epoch}
        project={DELIVERY_PROJECT}
        pkg={open ? model.package : null}
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async (quoteToken, consentToken) => {
          const next = await sendConfirmedRequest(window.api, DELIVERY_PROJECT, model.package, quoteToken, consentToken);
          if (next) setJob(next);
          setOpen(false);
        }}
      />
    </Stack>
  );
}
