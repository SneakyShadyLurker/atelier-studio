"""Provisioning hands its listen port to the install-permission hardening step."""
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'provision-private.py'
HARDEN = HERE / 'harden-install-permissions.ps1'


class StopAfterHardening(Exception):
    pass


def crypto_stubs():
    """Import-time stand-ins; the run stops before any key is generated."""
    names = ['cryptography', 'cryptography.x509', 'cryptography.x509.oid', 'cryptography.hazmat',
             'cryptography.hazmat.primitives', 'cryptography.hazmat.primitives.asymmetric']
    modules = {name: ModuleType(name) for name in names}
    modules['cryptography'].x509 = modules['cryptography.x509']
    modules['cryptography.x509.oid'].NameOID = object()
    modules['cryptography.hazmat.primitives'].hashes = object()
    modules['cryptography.hazmat.primitives'].serialization = object()
    modules['cryptography.hazmat.primitives.asymmetric'].rsa = object()
    return modules


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        shutil.copyfile(SCRIPT, self.stage / 'provision-private.py')

    def tearDown(self):
        shutil.rmtree(self.root)

    def hardening_call(self, *argv):
        calls = []

        def run(command, **_kwargs):
            calls.append(command)
            if command[0] == 'powershell.exe':
                raise StopAfterHardening
            return None

        with patch.dict(sys.modules, crypto_stubs()), \
                patch('subprocess.check_output', return_value='host\\account\n'), \
                patch('subprocess.run', side_effect=run), \
                patch.object(sys, 'argv', ['provision-private.py', *argv]):
            with self.assertRaises(StopAfterHardening):
                runpy.run_path(str(self.stage / 'provision-private.py'), run_name='__main__')
        return next(command for command in calls if command[0] == 'powershell.exe')

    def test_hardening_receives_the_configured_port(self):
        command = self.hardening_call('198.51.100.7', '--port', '8190')
        self.assertEqual(command[command.index('-Port') + 1], '8190')

    def test_hardening_receives_the_default_port(self):
        command = self.hardening_call('198.51.100.7')
        self.assertEqual(command[command.index('-Port') + 1], '7860')

    def test_hardening_script_checks_its_port_parameter(self):
        text = HARDEN.read_text()
        self.assertIn('[ValidateRange(1, 65535)][int]$Port = 7860', text)
        self.assertIn('$_.Port -eq $Port', text)
        self.assertNotIn('-eq 7860', text)


if __name__ == '__main__':
    unittest.main()
