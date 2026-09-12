"""Initialize a fresh, authenticated native MongoDB on localhost."""

import os
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import OperationFailure

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
host = os.getenv("MONGO_HOST", "127.0.0.1")
port = int(os.getenv("MONGO_PORT", "27017"))
if host not in {"127.0.0.1", "localhost"}:
    raise SystemExit("This initializer only supports a local MongoDB instance.")

credentials = {
    "username": os.environ["MONGO_ROOT_USER"],
    "password": os.environ["MONGO_ROOT_PASSWORD"],
    "authSource": "admin",
}
try:
    with MongoClient(host, port, **credentials, serverSelectionTimeoutMS=3000) as admin:
        admin.admin.command("usersInfo", credentials["username"])
except OperationFailure as exc:
    if exc.code != 18:
        raise
    # MongoDB's localhost exception allows the first administrator to be created.
    with MongoClient(host, port, serverSelectionTimeoutMS=3000) as bootstrap:
        bootstrap.admin.command(
            "createUser", credentials["username"], pwd=credentials["password"],
            roles=[{"role": "root", "db": "admin"}],
        )

with MongoClient(host, port, **credentials, serverSelectionTimeoutMS=3000) as admin:
    users = admin.admin.command("usersInfo", os.environ["MONGO_APP_USER"])
    if not users["users"]:
        admin.admin.command(
            "createUser", os.environ["MONGO_APP_USER"], pwd=os.environ["MONGO_APP_PASSWORD"],
            roles=[{"role": "readWrite", "db": "shop"}, {"role": "readWrite", "db": "blackbox"}],
        )
print("Local MongoDB users are ready.")
