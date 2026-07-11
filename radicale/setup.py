from setuptools import setup

setup(
    name='radicale_custom_auth',
    version='1.0',
    py_modules=['radicale_custom_auth'],
    entry_points={
        'radicale.auth': [
            'custom = radicale_custom_auth:Auth',
        ],
    },
)
