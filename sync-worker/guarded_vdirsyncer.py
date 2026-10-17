"""Runs `vdirsyncer -c <config> <command>` (vdirsyncer from PATH) behind outbound_guard's socket guard (#532).

Usage: python guarded_vdirsyncer.py <config> <command>

vdirsyncer follows redirects and resolves the linked hosts itself, for minutes, long after the worker
validated the stored URL. The policy comes from OUTBOUND_GUARD_POLICY (JSON: pins, trusted,
allow_public, see install_socket_guard); without it nothing runs. Redirects off a request's origin
fail (install_redirect_guard).
"""
import json
import os
import runpy
import shutil
import sys

import aiohttp

from outbound_guard import install_redirect_guard, install_socket_guard

config_path, command = sys.argv[1:]
policy = json.loads(os.environ["OUTBOUND_GUARD_POLICY"])
install_socket_guard(policy["pins"], policy["trusted"], policy["allow_public"])
install_redirect_guard(aiohttp)

executable = shutil.which("vdirsyncer")
if executable is None:
    sys.exit("vdirsyncer not found on PATH")
sys.argv = [executable, "-c", config_path, command]
runpy.run_path(executable, run_name="__main__")
