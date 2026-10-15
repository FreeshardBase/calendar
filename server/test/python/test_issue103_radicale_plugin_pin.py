"""Issue #103: the Radicale plugins declare the Radicale release whose auth API they implement.

`pip install /app` in radicale/Dockerfile installs the plugin package. Its install_requires must
pin the same Radicale as radicale/requirements.txt, so a Radicale bump that is not checked against
the plugin's `_login(self, login, password)` API fails the image build instead of the container
start.
"""
import os
import re
import sys
import types
import unittest
from unittest import mock

RADICALE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../radicale"))


def setup_kwargs():
    captured = {}
    fake_setuptools = types.ModuleType("setuptools")
    fake_setuptools.setup = lambda **kwargs: captured.update(kwargs)
    path = os.path.join(RADICALE_DIR, "setup.py")
    with open(path) as fh:
        code = compile(fh.read(), path, "exec")
    with mock.patch.dict(sys.modules, {"setuptools": fake_setuptools}):
        exec(code, {"__name__": "__main__", "__file__": path})
    return captured


def requirements_pin():
    with open(os.path.join(RADICALE_DIR, "requirements.txt")) as fh:
        for line in fh:
            match = re.match(r"^\s*radicale\s*==\s*([0-9][0-9.]*)\s*$", line, re.IGNORECASE)
            if match:
                return match.group(1)
    raise AssertionError("radicale/requirements.txt must pin radicale==<version>")


class TestRadicalePluginPin(unittest.TestCase):
    def test_plugin_package_requires_the_pinned_radicale(self):
        requires = setup_kwargs().get("install_requires", [])
        self.assertIn(f"radicale=={requirements_pin()}", requires)


if __name__ == "__main__":
    unittest.main()
