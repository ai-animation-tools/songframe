/** Проверка выбранного оригинала помогает просмотру и никогда не принимает материал. */
import type { AgentJob } from './agents';

export interface VideoReviewFrame {
  id: string;
  timeSeconds: number;
  path: string;
}
export interface VideoReviewFinding {
  verdict: 'match' | 'mismatch' | 'uncertain';
  /** Время от начала проверенного оригинала, а не от начала песни. */
  timeSeconds: number;
  description: string;
  frameIds: string[];
}
export interface VideoReviewReport {
  schemaVersion: 1;
  summary: string;
  findings: VideoReviewFinding[];
  limitations: string[];
}
export interface VideoReviewView {
  status: 'idle' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
  job: AgentJob | null;
  report: VideoReviewReport | null;
  frames: VideoReviewFrame[];
  stale: boolean;
  canStart: boolean;
  reason: string | null;
  error: string | null;
  durationSeconds: number | null;
}
export interface VideoReviewApi {
  view(project: string, packageDir: string): Promise<VideoReviewView>;
  start(project: string, packageDir: string): Promise<VideoReviewView>;
  cancel(project: string, packageDir: string): Promise<VideoReviewView>;
}
