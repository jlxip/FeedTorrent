"""Offline migration regressions, using synthetic secrets only."""
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('migration', ROOT / 'dev/scripts/migrate-publishing-key.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
PASSWORD = 'synthetic migration password'
SEED = bytes(range(32))
PUB = m.public_key(SEED).hex()
LEGACY = subprocess.check_output(['node', '--input-type=module', '-e', "import {encryptAge} from './dev/tests/age-fixture.mjs';process.stdout.write(encryptAge(Buffer.from(Array.from({length:32},(_,i)=>i)),'synthetic migration password'));"], cwd=ROOT)


class Migration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'publishing').mkdir()
        (self.root / 'instance.lock').touch(mode=0o600)
        self.path = self.root / 'publishing/library.json'
        self.original = {'version': 2, 'vault': {'public_key': PUB, 'ciphertext': list(LEGACY)}, 'feeds': {'sentinel': {'draft': {'body': 'Keep this'}, 'salt': [1, 2, 3]}}, 'next_operation': 7}
        self.path.write_text(json.dumps(self.original))
        self.before = self.path.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def test_converts_and_is_idempotent_with_only_ciphertext_changed(self):
        backup = m.migrate(self.root, lambda: PASSWORD)
        self.assertEqual(backup.read_bytes(), self.before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        value = json.loads(self.path.read_bytes())
        cipher = bytes(value['vault']['ciphertext'])
        self.assertEqual(m.decrypt_seed(cipher, PASSWORD.encode(), bytes.fromhex(PUB)), SEED)
        value['vault']['ciphertext'] = list(LEGACY)
        self.assertEqual(value, self.original)
        current, timestamp = self.path.read_bytes(), self.path.stat().st_mtime_ns
        self.assertIsNone(m.migrate(self.root, lambda: self.fail('Password asked for migrated key')))
        self.assertEqual(self.path.read_bytes(), current)
        self.assertEqual(self.path.stat().st_mtime_ns, timestamp)
        self.assertEqual(len(list(self.path.parent.glob('*.bak'))), 1)

    def test_wrong_password_and_corruption_do_not_write(self):
        with self.assertRaises(m.InvalidTag):
            m.migrate(self.root, lambda: 'wrong password')
        self.assertEqual(self.path.read_bytes(), self.before)
        damaged = dict(self.original)
        damaged['vault'] = {'public_key': PUB, 'ciphertext': list(LEGACY[:-1] + bytes([LEGACY[-1] ^ 1]))}
        self.path.write_text(json.dumps(damaged))
        before = self.path.read_bytes()
        with self.assertRaises(m.InvalidTag):
            m.migrate(self.root, lambda: PASSWORD)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.glob('*.bak')), [])

    def test_identity_and_format_validation(self):
        bad = json.loads(self.before)
        bad['vault']['public_key'] = '00' * 32
        self.path.write_text(json.dumps(bad))
        before = self.path.read_bytes()
        with self.assertRaises(m.MigrationError):
            m.migrate(self.root, lambda: PASSWORD)
        self.assertEqual(self.path.read_bytes(), before)
        for data in [b'FTKV\x02' + bytes(76), m.MAGIC + bytes(2), b'bad']:
            with self.assertRaises(m.MigrationError):
                m.decrypt_seed(data, PASSWORD.encode(), bytes.fromhex(PUB))
        cipher = m.encrypt_seed(SEED, PASSWORD.encode(), bytes.fromhex(PUB))
        for at in [5, 21, 33, 65, 80]:
            bad = bytearray(cipher); bad[at] ^= 1
            with self.assertRaises(m.InvalidTag):
                m.decrypt_seed(bytes(bad), PASSWORD.encode(), bytes.fromhex(PUB))

    def test_lock_and_symlink_preserve_files(self):
        with open(self.root / 'instance.lock', 'rb') as lock:
            m.fcntl.flock(lock, m.fcntl.LOCK_EX | m.fcntl.LOCK_NB)
            with self.assertRaisesRegex(m.MigrationError, 'Stop FeedTorrent'):
                m.migrate(self.root, lambda: self.fail('Password requested while server active'))
        self.assertEqual(self.path.read_bytes(), self.before)
        outside = self.root / 'outside.json'; outside.write_bytes(self.before)
        self.path.unlink(); self.path.symlink_to(outside)
        with self.assertRaises(OSError):
            m.migrate(self.root, lambda: PASSWORD)
        self.assertEqual(outside.read_bytes(), self.before)

    def test_failed_replace_preserves_original_and_cleans_temporary(self):
        with patch.object(m.os, 'replace', side_effect=OSError('synthetic write failure')):
            with self.assertRaises(OSError):
                m.migrate(self.root, lambda: PASSWORD)
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(list(self.path.parent.glob('.key-conversion-*')), [])
        self.assertEqual(next(self.path.parent.glob('*.bak')).read_bytes(), self.before)

    def test_cli_hides_password_and_does_not_accept_password_arguments(self):
        rejected = subprocess.run([sys.executable, str(SPEC.origin), '--password', PASSWORD], capture_output=True)
        self.assertNotIn(PASSWORD.encode(), rejected.stdout + rejected.stderr)
        pid, descriptor = pty.fork()
        if pid == 0:
            os.execv(sys.executable, [sys.executable, str(SPEC.origin), '--data-dir', str(self.root)])
        output = bytearray(); sent = False; status = None
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if select.select([descriptor], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(descriptor, 4096)
                    except OSError:
                        chunk = b''
                    output.extend(chunk)
                    if not sent and b'Current publishing password:' in output:
                        os.write(descriptor, PASSWORD.encode() + b'\n'); sent = True
                done, current = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = current; break
            self.assertIsNotNone(status, 'CLI did not complete')
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, output)
            self.assertNotIn(PASSWORD.encode(), output)
            self.assertTrue(bytes(json.loads(self.path.read_bytes())['vault']['ciphertext']).startswith(m.MAGIC))
        finally:
            os.close(descriptor)
            if status is None:
                os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)


if __name__ == '__main__':
    unittest.main()
