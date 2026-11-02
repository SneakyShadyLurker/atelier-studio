"""Activate only in the dedicated worker; preserve the interactive installation."""
import os

NODE_CLASS_MAPPINGS = {}
if os.environ.get('ATELIER_PRIVATE_WORKER') == '1':
    from .worker import NODE_CLASS_MAPPINGS
