import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { descriptionInput, ensureAvailable, publishRelease, setBuildVersion, versionInput } from './release.mjs';

const version = '0.2.0';
const repository = 'example/songframe';
const sha = '0123456789abcdef0123456789abcdef01234567';
const image = `songframe-${version}-linux-x86_64.AppImage`;
const zip = `songframe-${version}-win-x64.zip`;

// Маленькие настоящие файлы позволяют проверить границу публикации без сборки и сети.
function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'songframe-release-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hashes = {};
  for (const name of [image, zip]) {
    const binary = Buffer.from(`\0поставка ${name}\xff`);
    hashes[name] = createHash('sha256').update(binary).digest('hex');
    writeFileSync(join(directory, name), binary);
    writeFileSync(join(directory, `${name}.sha256`), `${hashes[name]}  ${name}\n`);
  }
  const json = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  json('linux-smoke-result.json', { ok: true, appimage: image, sha256: hashes[image] });
  json('windows-archive-check.json', {
    ok: true,
    zip,
    sha256: hashes[zip],
    target: 'win32-x64',
    nativeExecution: false
  });
  json('linux-distribution.json', { version, target: 'linux-x64' });
  writeFileSync(join(directory, 'THIRD_PARTY_LICENSES.md'), '# Лицензии тестовой поставки\n');
  return { directory, json, options: { version, description: 'Описание выпуска', repository, sha, directory } };
}

// Подмена принимает аргументы gh как массив и никогда не запускает процесс.
function fakeGh(handle = () => undefined) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      const result = handle(args);
      if (result !== undefined) return result;
      if (args[0] === 'api' && args[1] === '--paginate') return '';
      if (args[0] === 'api' && args[1]?.includes('/git/matching-refs/')) return '[]';
      return '';
    }
  };
}

test('версия принимает X.Y.Z и отклоняет префикс, ведущие нули и команды оболочки', () => {
  assert.equal(versionInput(version), version);
  assert.equal(versionInput('10.0.123'), '10.0.123');
  for (const value of ['v0.2.0', '00.2.0', '0.02.0', '0.2.00', '0.2.0; echo bad', '$(echo 0.2.0)']) {
    assert.throws(() => versionInput(value), /X\.Y\.Z/);
  }
});

test('описание обязательно и сохраняет многострочный Markdown буквально', () => {
  for (const value of ['', ' \n\t', undefined]) assert.throws(() => descriptionInput(value), /пустым/);
  const markdown = '# Выпуск\n\n- `пример`\n- $(printf опасно)\n';
  assert.equal(descriptionInput(markdown), markdown);
});

test('сборочная версия меняет только поле version в package.json', (context) => {
  const { directory } = fixture(context);
  const manifest = { name: 'пример', version: '0.1.0', private: true, scripts: { build: 'example' }, nested: [1, 2] };
  const path = join(directory, 'package.json');
  writeFileSync(path, JSON.stringify(manifest));
  setBuildVersion(version, directory);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...manifest, version });
  assert.throws(() => setBuildVersion('v0.3.0', directory), /X\.Y\.Z/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { ...manifest, version });
});

test('похожие теги и номера релизов не занимают точный номер', () => {
  const fake = fakeGh((args) => {
    if (args.includes('--paginate')) return 'v0.2.01\nv0.2.0-preview\n';
    return JSON.stringify([{ ref: 'refs/tags/v0.2.01' }, { ref: 'refs/tags/v0.2.0-preview' }]);
  });
  assert.equal(ensureAvailable(version, repository, fake.run), 'v0.2.0');
  assert.equal(fake.calls.length, 2);
});

test('точный Git-тег или релиз, включая черновик без тега, занимают номер', () => {
  for (const occupied of ['tag', 'draft']) {
    const fake = fakeGh((args) => {
      if (args.includes('--paginate')) return occupied === 'draft' ? 'v0.2.0\n' : '';
      return JSON.stringify(occupied === 'tag' ? [{ ref: 'refs/tags/v0.2.0' }] : []);
    });
    assert.throws(() => ensureAvailable(version, repository, fake.run), /уже существует/);
    assert.ok(fake.calls.every((args) => args[0] === 'api' && !args.includes('POST')));
  }
});

test('отсутствующий файл, повреждённая сумма и неподходящий отчёт останавливают публикацию до gh', (context) => {
  const corruptions = [
    ({ directory }) => rmSync(join(directory, 'THIRD_PARTY_LICENSES.md')),
    ({ directory }) => writeFileSync(join(directory, `${zip}.sha256`), 'неверная сумма'),
    ({ json }) => json('linux-smoke-result.json', { ok: false, appimage: image }),
    ({ json }) => json('windows-archive-check.json', { ok: true, zip, target: 'linux-x64', nativeExecution: true })
  ];
  for (const corrupt of corruptions) {
    const data = fixture(context);
    corrupt(data);
    const fake = fakeGh();
    assert.throws(() => publishRelease(data.options, fake.run));
    assert.deepEqual(fake.calls, []);
  }
});

test('версия inventory должна совпадать с номером релиза до любых обращений к gh', (context) => {
  const data = fixture(context);
  data.json('linux-distribution.json', { version: '0.1.0', target: 'linux-x64' });
  const fake = fakeGh();
  assert.throws(() => publishRelease(data.options, fake.run), /Версия Linux/);
  assert.deepEqual(fake.calls, []);
});

test('публикация создаёт точный ref, черновик с буквальным описанием, восемь файлов и лишь затем публичный релиз', (context) => {
  const { options, directory } = fixture(context);
  const description = '# Выпуск\n\n`код` и $(printf команда)\n';
  let notes;
  const fake = fakeGh((args) => {
    if (args[0] === 'release' && args[1] === 'create') {
      notes = args[args.indexOf('--notes-file') + 1];
      assert.equal(readFileSync(notes, 'utf8'), description);
    }
  });
  assert.equal(publishRelease({ ...options, description }, fake.run), 'v0.2.0');
  assert.deepEqual(fake.calls.slice(0, 2), [
    ['api', '--paginate', `repos/${repository}/releases`, '--jq', '.[].tag_name'],
    ['api', `repos/${repository}/git/matching-refs/tags/v${version}`]
  ]);
  assert.deepEqual(fake.calls.slice(2), [
    ['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', 'ref=refs/tags/v0.2.0', '-f', `sha=${sha}`],
    ['release', 'create', 'v0.2.0', '--verify-tag', '--draft', '--target', sha, '--title', 'v0.2.0', '--notes-file', notes],
    [
      'release',
      'upload',
      'v0.2.0',
      ...[
        image,
        `${image}.sha256`,
        zip,
        `${zip}.sha256`,
        'linux-distribution.json',
        'linux-smoke-result.json',
        'windows-archive-check.json',
        'THIRD_PARTY_LICENSES.md'
      ].map((name) => join(directory, name))
    ],
    ['release', 'edit', 'v0.2.0', '--draft=false', '--latest']
  ]);
  assert.throws(() => readFileSync(notes), { code: 'ENOENT' });
});

test('ошибка загрузки оставляет черновик и не вызывает публикацию', (context) => {
  const { options } = fixture(context);
  const fake = fakeGh((args) => {
    if (args[0] === 'release' && args[1] === 'upload') throw new Error('Сбой загрузки');
  });
  assert.throws(() => publishRelease(options, fake.run), /Сбой загрузки/);
  assert.ok(fake.calls.some((args) => args[0] === 'release' && args[1] === 'create' && args.includes('--draft')));
  assert.ok(!fake.calls.some((args) => args[0] === 'release' && args[1] === 'edit'));
});

test('ошибка создания тега не создаёт и не меняет релиз', (context) => {
  const { options } = fixture(context);
  const fake = fakeGh((args) => {
    if (args.includes('POST')) throw new Error('Тег уже занят');
  });
  assert.throws(() => publishRelease(options, fake.run), /Тег уже занят/);
  assert.equal(fake.calls.length, 3);
  assert.ok(!fake.calls.some((args) => args[0] === 'release'));
});

test('ошибка API при проверке доступности не начинает удалённых изменений', (context) => {
  const { options } = fixture(context);
  for (const failingCall of [1, 2]) {
    let callNumber = 0;
    const fake = fakeGh(() => {
      if (++callNumber === failingCall) throw new Error('API недоступен');
    });
    assert.throws(() => publishRelease(options, fake.run), /API недоступен/);
    assert.equal(fake.calls.length, failingCall);
    assert.ok(fake.calls.every((args) => args[0] === 'api' && !args.includes('POST')));
  }
});
