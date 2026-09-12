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
    with TestClient(create_app(uri, database, database)) as client:
        assert client.get("/api/health").json()["database"] == "connected"
        seeded_items = client.get("/api/items").json()
        assert len(seeded_items) == 5
        assert {item["supplier"]["name"] for item in seeded_items} == {
            "Audio Forge", "Connectivity Labs", "Peripheral Works",
        }
        assert connection[database].suppliers.count_documents({}) == 3
        assert connection[database].inventory.find_one({"sku": "KEY-001"})["supplier_id"] == "peripheral-works"
        response = client.post("/api/items", json={"sku": "test-001", "name": "Test item", "stock": 12})
        assert response.status_code == 201
        assert response.json()["sku"] == "TEST-001"
        assert "_id" not in response.json()
        assert connection[database].inventory.find_one({"sku": "TEST-001"})["stock"] == 12
        assert client.patch("/api/items/test-001", json={"stock": 7}).json()["stock"] == 7
        assert client.patch("/api/items/KEY-001", json={"stock": 3}).status_code == 200
        assert client.delete("/api/items/HUB-003").status_code == 204
        assert client.delete("/api/items/HUB-003").status_code == 404
    with TestClient(create_app(uri, database, database)) as client:
        items = {item["sku"]: item for item in client.get("/api/items").json()}
        assert items["TEST-001"]["stock"] == 7
        assert items["KEY-001"]["stock"] == 3
        assert "HUB-003" not in items


def test_conflicts_and_invalid_input(mongo):
    uri, database, _ = mongo
    with TestClient(create_app(uri, database, database)) as client:
        assert client.post("/api/items", json={"sku": "key-001", "name": "Duplicate", "stock": 1}).status_code == 409
        for stock in [-1, 1.5, True, "10", 1_000_001]:
            assert client.patch("/api/items/KEY-001", json={"stock": stock}).status_code == 422
        for name in ["", "   ", "x" * 101]:
            assert client.post("/api/items", json={"sku": "NEW", "name": name, "stock": 1}).status_code == 422
        assert client.post("/api/items", json={"sku": "bad/sku", "name": "Invalid", "stock": 1}).status_code == 422
        assert client.patch("/api/items/ABSENT", json={"stock": 1}).status_code == 404


def test_create_supplier_and_assign_to_new_item(mongo):
    uri, database, connection = mongo
    app = create_app(uri, database, database)
    with TestClient(app) as client:
        suppliers = client.get("/api/suppliers")
        assert suppliers.status_code == 200
        assert len(suppliers.json()) == 3

        created_supplier = client.post("/api/suppliers", json={"name": "  Acme Parts  "})
        assert created_supplier.status_code == 201
        supplier = created_supplier.json()
        assert supplier["name"] == "Acme Parts"
        assert client.post("/api/suppliers", json={"name": "acme parts"}).status_code == 409

        created_item = client.post("/api/items", json={
            "sku": "ACM-100",
            "name": "Acme adapter",
            "stock": 9,
            "supplier_id": supplier["id"],
        })
        assert created_item.status_code == 201
        assert created_item.json()["supplier"] == supplier
        assert connection[database].inventory.find_one({"sku": "ACM-100"})["supplier_id"] == supplier["id"]

        listed_item = next(item for item in client.get("/api/items").json() if item["sku"] == "ACM-100")
        assert listed_item["supplier"] == supplier
        assert client.post("/api/items", json={
            "sku": "BAD-SUPPLIER",
            "name": "Invalid supplier item",
            "stock": 1,
            "supplier_id": "does-not-exist",
        }).status_code == 422


def test_database_failure_is_reported(mongo):
    uri, database, _ = mongo

    class UnavailableInventory:
        def find_one(self, *_args, **_kwargs):
            raise ServerSelectionTimeoutError("internal database details")

    app = create_app(uri, database, database)
    with TestClient(app) as client:
        app.state.inventory = UnavailableInventory()
        response = client.get("/api/health")
        assert response.status_code == 503
        assert "internal database details" not in response.text


def test_frontend_and_explicit_cors(mongo, monkeypatch):
    uri, database, _ = mongo
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
    with TestClient(create_app(uri, database, database)) as client:
        assert client.get("/").status_code == 200
        admin = client.get("/admin")
        assert admin.status_code == 200
        assert "Operations | Blackbox" in admin.text
        assert client.get("/static/admin.css").status_code == 200
        assert client.get("/static/admin.js").status_code == 200
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
        delete_preflight = client.options("/api/items/KEY-001", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "DELETE",
        })
        assert delete_preflight.status_code == 200


def test_api_requests_write_structured_telemetry(mongo):
    uri, database, connection = mongo
    app = create_app(uri, database, database)
    with TestClient(app) as client:
        response = client.get("/api/items", headers={"X-Trace-ID": "trace-test-001"})
        assert response.status_code == 200
        assert response.headers["X-Trace-ID"] == "trace-test-001"
        app.state.telemetry.flush()

        record = connection[database].logs.find_one({"trace_id": "trace-test-001"})
        assert record["schema_version"] == 1
        assert record["service"] == "inventory"
        assert record["event"] == "request.completed"
        assert record["http_method"] == "GET"
        assert record["http_route"] == "/api/items"
        assert record["status_code"] == 200
        assert record["db_query_count"] == 1
        assert record["db_query_summary"] == {"inventory-with-supplier": 1}
        assert record["duration_ms"] >= 0
        assert record["error_type"] is None

        assert client.get("/").status_code == 200
        app.state.telemetry.flush()
        assert connection[database].logs.count_documents({}) == 1


def test_admin_overview_reads_persisted_telemetry(mongo):
    uri, database, _ = mongo
    app = create_app(uri, database, database)
    with TestClient(app) as client:
        assert client.get("/api/items").status_code == 200
        app.state.telemetry.flush()

        response = client.get("/api/admin/overview")
        assert response.status_code == 200
        body = response.json()
        assert body["summary"]["requests_per_minute"] == 1
        assert body["summary"]["healthy_services"] == 1
        assert body["services"][0]["id"] == "inventory"
        assert body["activity"][0]["http_route"] == "/api/items"
        assert body["telemetry"] == {"dropped_record_count": 0, "write_failure_count": 0}
