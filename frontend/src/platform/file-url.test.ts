import { describe, expect, it } from 'vitest';
import { fileUrl } from './file-url';

describe('fileUrl', () => {
  it('кодирует сегменты Linux-пути как Go FileURL', () => {
    expect(fileUrl('http://127.0.0.1:1', '/srv/test/Клип ?#%/a.mp3')).toBe('http://127.0.0.1:1/file/srv/test/%D0%9A%D0%BB%D0%B8%D0%BF%20%3F%23%25/a.mp3');
  });
  it('переводит путь Windows с диском в прямые слэши', () => {
    expect(fileUrl('http://127.0.0.1:1', 'C:\\Клипы\\a b.png')).toBe('http://127.0.0.1:1/file/C%3A/%D0%9A%D0%BB%D0%B8%D0%BF%D1%8B/a%20b.png');
  });
});
