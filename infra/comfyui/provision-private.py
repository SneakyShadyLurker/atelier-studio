"""Provision the private worker. Run from its stage directory (a child of the
ComfyUI install root) with the embedded Python:

    python provision-private.py <address> [--port 7860]

<address> is the IP address or DNS name the api uses to reach the worker. It
becomes the listen address in worker.json and the certificate's subject
alternative name.
"""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import secrets
import shutil
import subprocess

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

parser = argparse.ArgumentParser(description='Provision the Atelier private ComfyUI worker.')
parser.add_argument('address', help='IP address or DNS name the api uses to reach the worker')
parser.add_argument('--port', type=int, default=7860, help='listen port (default 7860)')
args = parser.parse_args()
address = args.address.strip()
try:
    ip = ipaddress.ip_address(address)
except ValueError:
    ip = None
if not address or (ip is not None and ip.is_unspecified):
    parser.error('address must be a specific IP address or DNS name')
if not 0 < args.port < 65536:
    parser.error('port must be between 1 and 65535')

STAGE = Path(__file__).resolve().parent
ROOT = STAGE.parent
PRIVATE = ROOT / 'atelier-private-secrets'
PRIVATE.mkdir(exist_ok=True)
# Account and SYSTEM only, before any key material is written.
account = subprocess.check_output(['whoami'], text=True, timeout=5).strip()
subprocess.run(['icacls', str(PRIVATE), '/inheritance:r', '/grant:r', account + ':(OI)(CI)F',
                '*S-1-5-18:(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL, timeout=10)
try:
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-File', str(STAGE / 'harden-install-permissions.ps1'), '-Root', str(ROOT),
                    '-Port', str(args.port)],
                   check=True, timeout=600)
except subprocess.TimeoutExpired:
    print('Installation ACL hardening timed out; the root ACL may be partially applied. '
          'Leave the worker stopped and restore the private install-acl-before snapshot before retrying.')
    raise SystemExit(1)
if not (PRIVATE / 'token').exists():
    (PRIVATE / 'token').write_text(secrets.token_urlsafe(48))
if not (PRIVATE / 'key.pem').exists():
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Atelier ComfyUI worker')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip) if ip is not None else x509.DNSName(address)]),
                           critical=False)
            .sign(key, hashes.SHA256()))
    (PRIVATE / 'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (PRIVATE / 'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
# Non-secret endpoint, the single source for the supervisor and the launcher.
(ROOT / 'worker.json').write_text(json.dumps({'address': address, 'port': args.port}, indent=2) + '\n')
shutil.copytree(STAGE / 'atelier_private', ROOT / 'ComfyUI/custom_nodes/atelier_private', dirs_exist_ok=True)
shutil.copyfile(STAGE / 'private-worker.py', ROOT / 'private-worker.py')
for name in ('LAUNCH ATELIER PRIVATE.bat', 'LAUNCH THIS.bat', 'start-private-worker.ps1'):
    # Match the native-tested Windows artifacts even when staged from Unix Git.
    data = (STAGE / name).read_text().replace('\r\n', '\n').replace('\n', '\r\n').encode()
    destination = ROOT / name
    backup = PRIVATE / 'launcher-before-private.bat'
    if name == 'LAUNCH THIS.bat' and destination.exists() and not backup.exists() and destination.read_bytes() != data:
        shutil.copyfile(destination, backup)
    destination.write_bytes(data)
print('private worker provisioned; credentials not displayed')
