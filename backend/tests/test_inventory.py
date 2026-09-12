import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient
from pymongo.errors import ServerSelectionTimeoutError

from backend.app import create_app


@pytest.fixture
def mongo():
    uri = os.getenv("MONGODB_TEST_URI")
    if not uri:
        pytest.skip("Set MONGODB_TEST_URI to a real MongoDB with permission to create test databases.")
    client = MongoClient(uri, serverSelectionTimeoutMS=2000)
    client.admin.command("ping")
    database = f"blackbox_test_{uuid4().hex}"
    yield uri, database, client
    client.drop_database(database)
    client.close()


def test_create_update_and_persist_after_restart(mongo):
    uri, database, connection = mongo
    with TestClient(create_app(uri, database)) as client:
        assert client.get("/api/health").json()["database"] == "connected"
        assert len(client.get("/api/items").json()) == 5
        response = client.post("/api/items", json={"sku": "test-001", "name": "Test item", "stock": 12})
        assert response.status_code == 201
        assert response.json()["sku"] == "TEST-001"
        assert "_id" not in response.json()
        assert connection[database].inventory.find_one({"sku": "TEST-001"})["stock"] == 12
        assert client.patch("/api/items/test-001", json={"stock": 7}).json()["stock"] == 7
        assert client.patch("/api/items/KEY-001", json={"stock": 3}).status_code == 200
    with TestClient(create_app(uri, database)) as client:
        items = {item["sku"]: item for item in client.get("/api/items").json()}
        assert items["TEST-001"]["stock"] == 7
        assert items["KEY-001"]["stock"] == 3


def test_conflicts_and_invalid_input(mongo):
    uri, database, _ = mongo
    with TestClient(create_app(uri, database)) as client:
        assert client.post("/api/items", json={"sku": "key-001", "name": "Duplicate", "stock": 1}).status_code == 409
        for stock in [-1, 1.5, True, "10", 1_000_001]:
            assert client.patch("/api/items/KEY-001", json={"stock": stock}).status_code == 422
        for name in ["", "   ", "x" * 101]:
            assert client.post("/api/items", json={"sku": "NEW", "name": name, "stock": 1}).status_code == 422
        assert client.post("/api/items", json={"sku": "bad/sku", "name": "Invalid", "stock": 1}).status_code == 422
        assert client.patch("/api/items/ABSENT", json={"stock": 1}).status_code == 404


def test_database_failure_is_reported(mongo):
    uri, database, _ = mongo

    class UnavailableInventory:
        def find_one(self, *_args, **_kwargs):
            raise ServerSelectionTimeoutError("internal database details")

    app = create_app(uri, database)
    with TestClient(app) as client:
        app.state.inventory = UnavailableInventory()
        response = client.get("/api/health")
        assert response.status_code == 503
        assert "internal database details" not in response.text


def test_frontend_and_explicit_cors(mongo, monkeypatch):
    uri, database, _ = mongo
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
    with TestClient(create_app(uri, database)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/static/app.js").status_code == 200
        allowed = client.options("/api/items", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        })
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
        blocked = client.options("/api/items", headers={
            "Origin": "http://unrelated.example", "Access-Control-Request-Method": "POST",
        })
        assert blocked.status_code == 400
