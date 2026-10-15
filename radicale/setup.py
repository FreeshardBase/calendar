from setuptools import setup

setup(
    name='radicale_custom_auth',
    version='1.0',
    py_modules=['radicale_custom_auth', 'radicale_custom_rights'],
    # The plugins implement the auth/rights API of this Radicale release (issue #103); keep in
    # step with requirements.txt and re-check the plugins before bumping it.
    install_requires=['radicale==3.4.1'],
    entry_points={
        'radicale.auth': [
            'custom = radicale_custom_auth:Auth',
        ],
        'radicale.rights': [
            'custom = radicale_custom_rights:Rights',
        ],
    },
)
