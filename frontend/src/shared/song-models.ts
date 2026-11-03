/** Комплект локальной разметки (вокал и уточнение границ) устанавливается отдельным действием. */
export interface SongModelSetup {
  directory: string;
  installed: boolean;
  totalBytes: number;
}
export const SONG_MODEL_ID = 'song-timing-v1';
