"""Exercise the actual FastAPI routing/static layer without starting MongoDB.

Not entering the TestClient lifespan is deliberate: these tests verify frontend
integration, not database availability. test_inventory.py owns real DB checks.
"""
import re
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app


def test_dashboard_and_inventory_routes_with_all_linked_assets():
    client = TestClient(create_app())
    for route in ("/", "/dashboard", "/inventory", "/static/inventory.html"):
        response = client.get(route)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        for path in re.findall(r'(?:src|href)="(/static/[^"?#]+)"', response.text):
            assert client.get(path).status_code == 200, path
    assert "OPERATIONS CONSOLE" in client.get("/").text
    assert 'id="item-form"' in client.get("/inventory").text
    assert 'href="/dashboard"' in client.get("/inventory").text
    assert 'href="/inventory"' in client.get("/").text


def test_dashboard_module_graph_is_served_as_javascript():
    client = TestClient(create_app())
    pending = ["/static/dashboard/app.mjs"]
    seen = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers["content-type"].split(";")[0] in (
            "text/javascript", "application/javascript"
        ), path
        for relative in re.findall(r"from ['\"](.+?\.mjs)['\"]", response.text):
            pending.append(str(Path(path).parent / relative))
    assert len(seen) == 5


def test_unimplemented_controller_routes_do_not_return_html_or_fake_success():
    client = TestClient(create_app())
    for path in ("/api/services", "/api/incidents", "/api/incidents/INC-0042"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
    for decision in ("approve", "reject"):
        response = client.post(f"/api/incidents/INC-0042/{decision}", json={
            "recommendation_id": "rec-0042-1", "incident_revision": 5,
            "idempotency_key": "must-not-execute",
        })
        assert response.status_code == 404
