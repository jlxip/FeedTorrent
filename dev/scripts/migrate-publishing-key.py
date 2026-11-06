#!/usr/bin/env python3
"""One-off conversion of FeedTorrent's age/scrypt vault; stop FeedTorrent first.

Usage: python3 dev/scripts/migrate-publishing-key.py --data-dir /path/to/state
Requires Python 3 + cryptography with Argon2id (validated with 50.0.0).
The existing password, Ed25519 identity and every feed are preserved.
"""
import argparse
import base64
import datetime
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import warnings

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, hmac
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"FTKV\x01"
HEADER = 33
SIZE = 81
MAX_LIBRARY = 256 * 1024 * 1024


class MigrationError(Exception):
    pass


def public_key(seed):
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()


def derive(password, salt):
    if not 1 <= len(password) <= 4096:
        raise MigrationError("Password must contain 1 to 4096 UTF-8 bytes")
    key = bytearray(32)
    Argon2id(salt=salt, length=32, iterations=3, lanes=4, memory_cost=65536).derive_into(password, key)
    return key


def validate_envelope(data):
    if len(data) != SIZE or not data.startswith(MAGIC):
        raise MigrationError("Unsupported or damaged FTKV key")


def encrypt_seed(seed, password, pub, *, salt=None, nonce=None):
    if len(seed) != 32 or public_key(seed) != pub:
        raise MigrationError("Encrypted key identity mismatch")
    salt = os.urandom(16) if salt is None else salt
    nonce = os.urandom(12) if nonce is None else nonce
    if len(salt) != 16 or len(nonce) != 12:
        raise MigrationError("Invalid encryption header")
    header = MAGIC + salt + nonce
    key = derive(password, salt)
    try:
        return header + ChaCha20Poly1305(key).encrypt(nonce, seed, header + pub)
    finally:
        key[:] = bytes(len(key))


def decrypt_seed(data, password, pub):
    validate_envelope(data)
    key = derive(password, data[5:21])
    try:
        seed = bytearray(ChaCha20Poly1305(key).decrypt(data[21:33], data[33:], data[:33] + pub))
        if public_key(seed) != pub:
            seed[:] = bytes(len(seed))
            raise MigrationError("Encrypted key identity mismatch")
        return seed
    finally:
        key[:] = bytes(len(key))


def decrypt_legacy(data, password):
    """Only the single scrypt recipient / 32-byte payload emitted by FeedTorrent."""
    if len(data) > 4096:
        raise MigrationError("Invalid encrypted key size")
    match = re.match(rb"age-encryption.org/v1\n-> scrypt ([A-Za-z0-9+/]+) ([1-9][0-9]*)\n([A-Za-z0-9+/]+)\n--- ([A-Za-z0-9+/]+)\n", data)
    if not match:
        raise MigrationError("Not a supported legacy FeedTorrent key")

    def b64(value):
        return base64.b64decode(value + b"=" * (-len(value) % 4), validate=True)

    salt, wrapped, mac = (b64(match[i]) for i in (1, 3, 4))
    log_n = int(match[2])
    payload = data[match.end():]
    if not 1 <= log_n <= 20 or len(salt) != 16 or len(wrapped) != 32 or len(mac) != 32 or len(payload) != 64:
        raise MigrationError("Invalid legacy FeedTorrent key")
    wrap_key = bytearray(Scrypt(salt=b"age-encryption.org/v1/scrypt" + salt, length=32, n=2 ** log_n, r=8, p=1).derive(password))
    file_key = None
    try:
        file_key = bytearray(ChaCha20Poly1305(wrap_key).decrypt(bytes(12), wrapped, None))

        def hkdf(salt, info):
            return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(file_key)

        check = hmac.HMAC(hkdf(b"", b"header"), hashes.SHA256())
        check.update(data[:data.index(b"\n--- ") + 4])
        check.verify(mac)
        seed = bytearray(ChaCha20Poly1305(hkdf(payload[:16], b"payload")).decrypt(bytes(11) + b"\x01", payload[16:], None))
        if len(seed) != 32:
            raise MigrationError("Invalid signing seed")
        return seed
    finally:
        wrap_key[:] = bytes(len(wrap_key))
        if file_key is not None:
            file_key[:] = bytes(len(file_key))


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise MigrationError("Duplicate JSON field")
        value[key] = item
    return value


def read_library(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        data = stream.read(MAX_LIBRARY + 1)
    if len(data) > MAX_LIBRARY:
        raise MigrationError("Publishing library exceeds 256 MiB")
    return data


def hidden_password():
    # getpass must never fall back to echoing or reading a password from a pipe.
    with open("/dev/tty", "w") as terminal:
        if not terminal.isatty():
            raise MigrationError("Run this script in an interactive terminal")
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("Current publishing password: ", stream=terminal)


def migrate(data_dir, password_provider=hidden_password):
    folder = Path(data_dir).resolve(strict=True)
    path = folder / "publishing/library.json"
    with os.fdopen(os.open(folder / "instance.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MigrationError("Stop FeedTorrent before converting its publishing key") from None
        original = read_library(path)
        library = json.loads(original, object_pairs_hook=unique_object)
        vault = library.get("vault")
        if not isinstance(vault, dict) or set(vault) != {"public_key", "ciphertext"}:
            raise MigrationError("Missing or invalid publishing key")
        pub = bytes.fromhex(vault["public_key"])
        values = vault["ciphertext"]
        if len(pub) != 32 or not isinstance(values, list) or len(values) > 4096 or any(type(v) is not int or not 0 <= v <= 255 for v in values):
            raise MigrationError("Invalid publishing key")
        encrypted = bytes(values)
        if encrypted.startswith(MAGIC):
            validate_envelope(encrypted)
            return None
        password = bytearray(password_provider().encode("utf-8"))
        seed = checked = None
        temporary = None
        try:
            if not 1 <= len(password) <= 4096:
                raise MigrationError("Password must contain 1 to 4096 UTF-8 bytes")
            seed = decrypt_legacy(encrypted, password)
            if public_key(seed).hex() != vault["public_key"]:
                raise MigrationError("Encrypted key identity mismatch")
            converted = encrypt_seed(seed, password, pub)
            checked = decrypt_seed(converted, password, pub)
            if not secrets.compare_digest(seed, checked):
                raise MigrationError("Conversion verification failed")
            vault["ciphertext"] = list(converted)
            candidate = json.dumps(library, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(candidate) > MAX_LIBRARY:
                raise MigrationError("Publishing library exceeds 256 MiB")
            if read_library(path) != original:
                raise MigrationError("Publishing library changed during conversion")
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = path.with_name("library.pre-argon2id-" + stamp + ".bak")
            with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                stream.write(original)
                stream.flush()
                os.fsync(stream.fileno())
            descriptor, temporary = tempfile.mkstemp(prefix=".key-conversion-", dir=path.parent)
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(candidate)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            temporary = None
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return backup
        finally:
            password[:] = bytes(len(password))
            for value in (seed, checked):
                if value is not None:
                    value[:] = bytes(len(value))
            if temporary is not None:
                os.unlink(temporary)


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, message):
            self.print_usage(sys.stderr)
            self.exit(2, "Invalid arguments; passwords are only entered at the terminal prompt\n")

    parser = Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        backup = migrate(args.data_dir)
        print("Converted to Argon2id; original encrypted-key backup: " + str(backup) if backup else "Already Argon2id; nothing changed")
    except (InvalidSignature, InvalidTag):
        print("Incorrect password or damaged key; original preserved", file=sys.stderr)
        return 1
    except MigrationError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, OverflowError, getpass.GetPassWarning):
        # Do not expose exceptions that could contain input or decrypted material.
        print("Conversion failed; check the data directory, key format and that FeedTorrent is stopped", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Cancelled", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
