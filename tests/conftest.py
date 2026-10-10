import os
import tempfile
from pathlib import Path
# Isolate the new audit format from legacy v1.6 log files during tests.
TEST_AUDIT_DIR = tempfile.TemporaryDirectory(prefix='oma-v17-tests-')
os.environ['OMA_AUDIT_PATH'] = str(Path(TEST_AUDIT_DIR.name) / 'audit.jsonl')
