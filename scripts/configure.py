"""Generate local credentials once; never overwrite existing configuration."""

import os
import secrets
from pathlib import Path

root = Path(__file__).resolve().parent.parent
target = root / ".env"
try:
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    print("Existing .env kept.")
else:
    with os.fdopen(descriptor, "w") as config:
        config.write(
            "MONGO_ROOT_USER=blackbox_admin\n"
            f"MONGO_ROOT_PASSWORD={secrets.token_hex(24)}\n"
            "MONGO_APP_USER=blackbox_app\n"
            f"MONGO_APP_PASSWORD={secrets.token_hex(24)}\n"
            "MONGO_HOST=127.0.0.1\nMONGO_PORT=27017\nMONGO_DATABASE=shop\n"
            "HTTP_HOST=127.0.0.1\nHTTP_PORT=8000\nCORS_ORIGINS=\n"
        )
    print("Created .env with generated credentials.")
