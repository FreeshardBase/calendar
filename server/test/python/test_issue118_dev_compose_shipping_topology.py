"""Issue #118: the dev compose has the shipping topology.

The store template (app-repository apps/webcalendar/docker-compose.yml.template) runs the
three services on one bind-mounted data directory, talks plain HTTP to Radicale on the
private network, publishes no Radicale port and takes every setting from template
variables. This parses docker-compose.yml as Compose does (YAML) and checks each of the six
axes the issue lists, so a dev stack that drifts from the shipping shape fails here.
"""

import os
import re
import unittest

import yaml

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
COMPOSE_PATH = os.path.join(ROOT_DIR, 'docker-compose.yml')
DATA_DIR = './data'
INTERNAL_URL = 'http://caldav-server:5232'
SECRETS = {
    'SESSION_SECRET',
    'SYSTEM_SYNC_SECRET',
    'ENCRYPTION_KEY',
    'INTERNAL_WEBHOOK_SECRET',
    'HTTP_HEADER_AUTH_SECRET',
}
VAR = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}')


def interpolate(value, env):
    """Compose variable substitution: ${V}, ${V:-default}, ${V-default}, ${V:?err}, ${V?err}."""

    def substitute(match):
        name, op, arg = match.group(1), match.group(2), match.group(3)
        present = name in env
        empty = not env.get(name)
        if op in (':?', '?') and (not present or (op == ':?' and empty)):
            raise LookupError(f'required variable {name} is missing a value: {arg}')
        if op in (':-', '-') and (not present or (op == ':-' and empty)):
            return arg
        return env.get(name, '')

    return VAR.sub(substitute, str(value))


def environment(service):
    env = service.get('environment') or {}
    if isinstance(env, list):
        env = dict(item.split('=', 1) for item in env)
    return env


def mounts(service):
    """(source, target, mode) for each short-syntax volume entry."""
    result = []
    for entry in service.get('volumes') or []:
        parts = entry.split(':')
        result.append((parts[0], parts[1], parts[2] if len(parts) > 2 else 'rw'))
    return result


class DevComposeShippingTopologyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(COMPOSE_PATH, encoding='utf-8') as handle:
            cls.compose = yaml.safe_load(handle)
        cls.services = cls.compose['services']

    def test_services(self):
        self.assertEqual(set(self.services), {'webcalendar', 'caldav-server', 'sync-worker'})

    # Axes 1 and 6: one bind mount, no named volumes at all.
    def test_no_named_volumes_are_declared(self):
        self.assertFalse(self.compose.get('volumes'), 'shipping template declares no named volumes')

    def test_every_service_mounts_the_single_data_bind_mount_and_nothing_else(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                sources = {source for source, _target, _mode in mounts(service)}
                self.assertEqual(sources, {DATA_DIR}, f'{name} mounts {sorted(sources)}')

    # Axis 2: vdirsyncer status is a plain path inside the data mount, not a nested volume.
    def test_no_mount_is_nested_inside_another(self):
        for name, service in self.services.items():
            targets = [target.rstrip('/') for _source, target, _mode in mounts(service)]
            with self.subTest(service=name):
                self.assertEqual(len(targets), 1, f'{name} has several mounts: {targets}')

    def test_sync_status_lives_inside_the_data_mount(self):
        worker = self.services['sync-worker']
        (_source, target, _mode), = mounts(worker)
        status_root = environment(worker)['STATUS_ROOT']
        self.assertTrue(status_root.startswith(target.rstrip('/') + '/'),
                        f'STATUS_ROOT {status_root} must lie inside {target}')

    # Axis 3: Radicale is reachable only on the compose network.
    def test_radicale_publishes_no_port(self):
        caldav = self.services['caldav-server']
        self.assertNotIn('ports', caldav)
        self.assertNotIn('network_mode', caldav)

    # Axis 4: plain HTTP internally, no TLS material anywhere.
    def test_internal_transport_is_plain_http(self):
        self.assertEqual(environment(self.services['webcalendar'])['INTERNAL_CALDAV_URL'], INTERNAL_URL)
        self.assertEqual(environment(self.services['sync-worker'])['LOCAL_CALDAV_URL'], INTERNAL_URL)

    def test_radicale_serves_plain_http(self):
        caldav = self.services['caldav-server']
        self.assertEqual(str(environment(caldav)['RADICALE_SSL']).lower(), 'false')
        healthcheck = ' '.join(caldav['healthcheck']['test'])
        self.assertIn('http://localhost:5232/', healthcheck)
        self.assertNotIn('https://', healthcheck)

    def test_no_tls_bypass_or_certificate_mount(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertNotIn('NODE_TLS_REJECT_UNAUTHORIZED', environment(service))
                for source, target, _mode in mounts(service):
                    self.assertNotIn('ssl', f'{source}:{target}')

    # Axis 5: configuration comes from variables, never from an env_file or a literal secret.
    def test_no_service_reads_an_env_file(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertNotIn('env_file', service)

    def test_secrets_are_required_variables(self):
        seen = set()
        for name, service in self.services.items():
            for key, value in environment(service).items():
                if key not in SECRETS:
                    continue
                seen.add(key)
                with self.subTest(service=name, variable=key):
                    with self.assertRaises(LookupError, msg=f'{key} must not resolve without a value'):
                        interpolate(value, {})
                    self.assertEqual(interpolate(value, {key: 'testsecret'}), 'testsecret')
        self.assertEqual(seen, SECRETS)

    def test_every_service_resolves_with_the_example_env(self):
        example = {}
        with open(os.path.join(ROOT_DIR, '.env.example'), encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    example[key] = value
        for name, service in self.services.items():
            for key, value in environment(service).items():
                with self.subTest(service=name, variable=key):
                    interpolate(value, example)

    def test_services_start_as_root_like_the_store_template(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertEqual(service.get('user'), '0:0')


if __name__ == '__main__':
    unittest.main()
