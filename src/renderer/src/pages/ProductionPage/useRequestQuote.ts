/** Оценка стоимости относится к одному открытому подтверждению и не переживает смену запроса. */
import { useEffect, useState } from 'react';
import { aiActionProblem } from '@shared/ai-access';
import type { PackageView, ProductionQuote } from '@shared/types';
import { useApp } from '../../state';

export function useRequestQuote(project: string, pkg: PackageView | null) {
  const { describeError, aiAccess } = useApp();
  const aiProblem = aiActionProblem(aiAccess, pkg?.request?.kind === 'image' ? 'image' : 'video');
  const [storedQuote, setQuote] = useState<{ context: string; value: ProductionQuote } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const dir = pkg?.dir;
  const sha = pkg?.request?.sha256;
  const decisionToken = pkg?.decisionToken;
  const context = `${project}\0${dir ?? ''}\0${sha ?? ''}\0${decisionToken ?? ''}`;
  const quote = storedQuote?.context === context ? storedQuote.value : null;

  useEffect(() => {
    let active = true;
    setQuote(null);
    setError(null);
    setLoading(false);
    if (!dir || !sha || aiProblem) return;
    setLoading(true);
    void window.api.production
      .quote(project, dir, sha, decisionToken)
      .then((next) => {
        if (!active) return;
        if (next.requestSha !== sha) throw new Error('Оценка относится к другому запросу. Откройте пакет заново.');
        setQuote({ context, value: next });
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [context, project, dir, sha, decisionToken, aiProblem, describeError, revision]);

  return {
    quote,
    error,
    loading,
    refreshQuote: () => {
      setQuote(null);
      setRevision((current) => current + 1);
    },
    consumeQuote: () => setQuote(null)
  };
}
