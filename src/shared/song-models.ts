/** Комплект локальной разметки не зависит от модели Whisper и устанавливается отдельным действием. */
export interface SongModelSetup {
  directory: string;
  installed: boolean;
  totalBytes: number;
}
export const SONG_MODEL_ID = 'song-timing-v1';
