import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const helper = new URL('./disk-image.mjs', import.meta.url).href;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'feedtorrent-disk-image-'));
  try {
    const bin = join(root, 'bin'), calls = join(root, 'calls');
    const mount = join(root, 'volume with spaces');
    await mkdir(bin); await mkdir(mount);
    await writeFile(join(bin, 'hdiutil'), `#!/bin/sh
set -eu
test "$#" = 2 && test "$1" = detach && test "$2" = "$TEST_MOUNT"
count=0
if [ -f "$TEST_CALLS" ]; then count=$(cat "$TEST_CALLS"); fi
count=$((count + 1)); printf '%s\\n' "$count" > "$TEST_CALLS"
if [ "$count" -lt "$SUCCESS_AT" ]; then echo 'fixture detach failure' >&2; exit "$FAIL_CODE"; fi
`, {mode: 0o755});
    const invoke = (successAt, code = 16) => exec(process.execPath,
      ['--input-type=module', '-e', `import {detachImage} from ${JSON.stringify(helper)}; await detachImage(process.env.TEST_MOUNT);`],
      {cwd: resolve('.'), env: {...process.env, PATH: bin + ':' + process.env.PATH,
        TEST_CALLS: calls, TEST_MOUNT: mount, SUCCESS_AT: String(successAt), FAIL_CODE: String(code)}, timeout: 15000});
    await run({invoke, count: async () => Number((await readFile(calls, 'utf8')).trim())});
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('a busy test volume can detach after its holder releases it', async () => {
  await fixture(async ({invoke, count}) => {
    const result = await invoke(2);
    assert.equal(await count(), 2);
    assert.match(result.stderr, /busy/);
  });
});
test('persistent EBUSY fails cleanup after the bounded wait', async () => {
  await fixture(async ({invoke, count}) => {
    await assert.rejects(invoke(99), error => {
      assert.match(error.stderr, /code: 16/);
      assert.match(error.stderr, /fixture detach failure/);
      return true;
    });
    assert.equal(await count(), 5);
  });
});
test('other detach errors fail immediately with their diagnostic', async () => {
  await fixture(async ({invoke, count}) => {
    await assert.rejects(invoke(99, 5), error => {
      assert.match(error.stderr, /code: 5/);
      assert.match(error.stderr, /fixture detach failure/);
      return true;
    });
    assert.equal(await count(), 1);
  });
});
