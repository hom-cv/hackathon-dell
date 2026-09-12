import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter
from typing import Literal
from urllib.parse import quote_plus
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from backend.detection import IncidentDetector
from backend.telemetry import TelemetryWriter

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
logger = logging.getLogger(__name__)


def database_call(request: Request, fingerprint: str, operation):
    """Execute one application database operation and record its safe fingerprint."""
    request.state.db_query_count += 1
    summary = request.state.db_query_summary
    summary[fingerprint] = summary.get(fingerprint, 0) + 1
    return operation()


def mongo_uri() -> str:
    if uri := os.getenv("MONGODB_URI"):
        return uri
    host = os.getenv("MONGO_HOST", "127.0.0.1")
    port = os.getenv("MONGO_PORT", "27017")
    user = os.getenv("MONGO_APP_USER", "")
    password = os.getenv("MONGO_APP_PASSWORD", "")
    if user and password:
        return f"mongodb://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/?authSource=admin"
    return f"mongodb://{host}:{port}/"


class NewItem(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    sku: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=100)
    stock: int = Field(ge=0, le=1_000_000, strict=True)
    supplier_id: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("sku")
    @classmethod
    def normalize_sku(cls, value: str) -> str:
        return value.upper()


class StockUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stock: int = Field(ge=0, le=1_000_000, strict=True)


class Supplier(BaseModel):
    id: str
    name: str


class NewSupplier(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=100)


class Item(BaseModel):
    sku: str
    name: str
    stock: int
    created_at: datetime
    updated_at: datetime
    supplier: Supplier | None = None


class EvidenceReference(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    kind: Literal[
        "log", "trace", "metric", "rule", "baseline", "deployment", "git_diff", "source",
    ]
    reference: str = Field(min_length=1, max_length=500)
    summary: str = Field(min_length=1, max_length=1000)


class AgentActivity(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    kind: Literal[
        "query_telemetry", "inspect_deployment", "inspect_git_diff",
        "inspect_source", "correlate_evidence", "other",
    ]
    summary: str = Field(min_length=1, max_length=1000)


class Recommendation(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    kind: Literal["rollback", "code_change", "monitor", "none"]
    summary: str = Field(min_length=1, max_length=1000)
    rationale: str = Field(min_length=1, max_length=2000)
    target: str | None = Field(default=None, max_length=500)
    requires_operator_approval: bool = True

    @model_validator(mode="after")
    def protect_mutating_recommendations(self):
        if self.kind in {"rollback", "code_change"} and not self.requires_operator_approval:
            raise ValueError("rollback and code-change recommendations require operator approval")
        return self


class InvestigationSubmission(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    agent_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    status: Literal["in_progress", "completed", "failed"]
    summary: str = Field(min_length=1, max_length=2000)
    diagnosis: str | None = Field(default=None, max_length=5000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    actions_taken: list[AgentActivity] = Field(default_factory=list, max_length=50)
    evidence: list[EvidenceReference] = Field(default_factory=list, max_length=100)
    recommendations: list[Recommendation] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def require_completed_findings(self):
        if self.status == "completed" and (not self.diagnosis or self.confidence is None):
            raise ValueError("completed investigations require diagnosis and confidence")
        return self


class Investigation(InvestigationSubmission):
    id: str
    incident_id: str
    demo_run_id: str
    created_at: datetime


class IncidentClaimRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    agent_id: str = Field(min_length=1, max_length=100)


SEED_ITEMS = [
    {"sku": "KEY-001", "name": "Mechanical keyboard", "stock": 24, "supplier_id": "peripheral-works"},
    {"sku": "MOU-002", "name": "Wireless mouse", "stock": 8, "supplier_id": "peripheral-works"},
    {"sku": "HUB-003", "name": "USB-C hub", "stock": 0, "supplier_id": "connectivity-labs"},
    {"sku": "CAB-004", "name": "USB-C cable", "stock": 52, "supplier_id": "connectivity-labs"},
    {"sku": "AUD-005", "name": "Studio headphones", "stock": 16, "supplier_id": "audio-forge"},
]

SEED_SUPPLIERS = [
    {"_id": "peripheral-works", "name": "Peripheral Works"},
    {"_id": "connectivity-labs", "name": "Connectivity Labs"},
    {"_id": "audio-forge", "name": "Audio Forge"},
]

ITEMS_WITH_SUPPLIERS_PIPELINE = [
    {"$lookup": {
        "from": "suppliers",
        "localField": "supplier_id",
        "foreignField": "_id",
        "as": "supplier_matches",
    }},
    {"$set": {
        "supplier": {
            "$cond": [
                {"$gt": [{"$size": "$supplier_matches"}, 0]},
                {"$let": {
                    "vars": {"match": {"$arrayElemAt": ["$supplier_matches", 0]}},
                    "in": {"id": "$$match._id", "name": "$$match.name"},
                }},
                None,
            ]
        }
    }},
    {"$project": {"_id": 0, "supplier_id": 0, "supplier_matches": 0}},
    {"$sort": {"sku": 1}},
]


def create_app(
    uri: str | None = None,
    database: str | None = None,
    telemetry_database: str | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = MongoClient(
            uri or mongo_uri(), serverSelectionTimeoutMS=3000,
            connectTimeoutMS=3000, socketTimeoutMS=5000, tz_aware=True,
        )
        try:
            client.admin.command("ping")
            application_database = client[database or os.getenv("MONGO_DATABASE", "shop")]
            collection = application_database.inventory
            suppliers = application_database.suppliers
            collection.create_index("sku", unique=True)
            now = datetime.now(timezone.utc)
            for supplier in SEED_SUPPLIERS:
                suppliers.update_one(
                    {"_id": supplier["_id"]}, {"$setOnInsert": supplier}, upsert=True,
                )
                suppliers.update_one(
                    {"_id": supplier["_id"], "normalized_name": {"$exists": False}},
                    {"$set": {"normalized_name": supplier["name"].casefold()}},
                )
            suppliers.create_index("normalized_name", unique=True)
            if collection.find_one({}, {"_id": 1}) is None:
                for item in SEED_ITEMS:
                    collection.update_one(
                        {"sku": item["sku"]},
                        {"$setOnInsert": {**item, "created_at": now, "updated_at": now}},
                        upsert=True,
                    )
            for item in SEED_ITEMS:
                # Schema backfill only: never replace edited names, stock, or timestamps.
                collection.update_one(
                    {"sku": item["sku"], "supplier_id": {"$exists": False}},
                    {"$set": {"supplier_id": item["supplier_id"]}},
                )
            app.state.mongo = client
            app.state.inventory = collection
            app.state.suppliers = suppliers
            evidence = client[telemetry_database or os.getenv("TELEMETRY_DATABASE", "blackbox")]
            logs = evidence.logs
            logs.create_index([("demo_run_id", 1), ("service", 1), ("timestamp", -1)])
            logs.create_index("trace_id")
            evidence.baselines.create_index(
                [("demo_run_id", 1), ("service", 1), ("route", 1)], unique=True,
            )
            evidence.incidents.create_index("dedup_key", unique=True)
            evidence.incidents.create_index(
                [("demo_run_id", 1), ("state", 1), ("created_at", -1)]
            )
            evidence.investigations.create_index(
                [("demo_run_id", 1), ("incident_id", 1), ("created_at", 1)]
            )
            queue_size = max(1, int(os.getenv("TELEMETRY_QUEUE_SIZE", "10000")))
            app.state.telemetry = TelemetryWriter(logs, queue_size=queue_size)
            app.state.evidence = evidence
            app.state.telemetry.start()
            app.state.detector = IncidentDetector(
                evidence,
                run_id=os.getenv("DEMO_RUN_ID", "local"),
                interval_seconds=max(0.25, float(os.getenv("DETECTION_INTERVAL_SECONDS", "2"))),
            )
            app.state.detector.start()
            yield
        finally:
            if detector := getattr(app.state, "detector", None):
                detector.close()
            if telemetry := getattr(app.state, "telemetry", None):
                telemetry.close()
            client.close()

    app = FastAPI(title="Healbot Inventory API", lifespan=lifespan)
    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"],
        )

    @app.middleware("http")
    async def record_request(request: Request, call_next):
        if not (request.url.path.startswith("/api/") or request.url.path == "/healthz"):
            return await call_next(request)

        trace_id = request.headers.get("x-trace-id") or uuid4().hex
        request.state.db_query_count = 0
        request.state.db_query_summary = {}
        started_at = datetime.now(timezone.utc)
        started = perf_counter()
        status_code = 500
        error_type = None
        try:
            response = await call_next(request)
            status_code = response.status_code
            if status_code >= 400:
                error_type = f"HTTP_{status_code}"
            response.headers["X-Trace-ID"] = trace_id
            return response
        except Exception as exc:
            error_type = type(exc).__name__
            raise
        finally:
            duration_ms = (perf_counter() - started) * 1000
            level = "ERROR" if status_code >= 500 else "WARNING" if status_code >= 400 else "INFO"
            request.app.state.telemetry.record(
                {
                    "_id": uuid4().hex,
                    "schema_version": 1,
                    "demo_run_id": os.getenv("DEMO_RUN_ID", "local"),
                    "timestamp": datetime.now(timezone.utc),
                    "started_at": started_at,
                    "service": "inventory",
                    "deployment_id": os.getenv("DEPLOYMENT_ID", "inventory-local"),
                    "git_sha": os.getenv("GIT_SHA", "unknown"),
                    "trace_id": trace_id,
                    "event": "request.completed",
                    "level": level,
                    "duration_ms": round(duration_ms, 3),
                    "status_code": status_code,
                    "db_query_count": request.state.db_query_count,
                    "db_query_summary": request.state.db_query_summary,
                    "error_type": error_type,
                    "http_method": request.method,
                    "http_route": request.url.path,
                }
            )

    @app.exception_handler(PyMongoError)
    async def database_error(_request: Request, exc: PyMongoError):
        logger.error("MongoDB operation failed: %s", type(exc).__name__)
        return JSONResponse(status_code=503, content={"detail": "Database unavailable. Try again shortly."})

    @app.get("/healthz", include_in_schema=False)
    @app.get("/api/health")
    def health(request: Request):
        database_call(
            request,
            "inventory-health",
            lambda: request.app.state.inventory.find_one({}, {"_id": 1}),
        )
        return {"status": "ok", "database": "connected"}

    @app.get("/api/items", response_model=list[Item])
    def list_items(request: Request):
        return database_call(
            request,
            "inventory-with-supplier",
            lambda: list(request.app.state.inventory.aggregate(ITEMS_WITH_SUPPLIERS_PIPELINE)),
        )

    @app.get("/api/suppliers", response_model=list[Supplier])
    def list_suppliers(request: Request):
        documents = database_call(
            request,
            "supplier-list",
            lambda: list(request.app.state.suppliers.find({}, {"normalized_name": 0}).sort("name", 1)),
        )
        return [{"id": document["_id"], "name": document["name"]} for document in documents]

    @app.post("/api/suppliers", response_model=Supplier, status_code=201)
    def create_supplier(supplier: NewSupplier, request: Request):
        document = {
            "_id": f"supplier-{uuid4().hex[:12]}",
            "name": supplier.name,
            "normalized_name": supplier.name.casefold(),
        }
        try:
            database_call(
                request,
                "supplier-insert",
                lambda: request.app.state.suppliers.insert_one(document.copy()),
            )
        except DuplicateKeyError:
            raise HTTPException(409, "A supplier with that name already exists.") from None
        return {"id": document["_id"], "name": document["name"]}

    @app.post("/api/items", response_model=Item, status_code=201)
    def create_item(item: NewItem, request: Request):
        now = datetime.now(timezone.utc)
        document = {**item.model_dump(), "created_at": now, "updated_at": now}
        supplier = None
        if item.supplier_id:
            supplier_document = database_call(
                request,
                "supplier-by-id",
                lambda: request.app.state.suppliers.find_one(
                    {"_id": item.supplier_id}, {"normalized_name": 0}
                ),
            )
            if supplier_document is None:
                raise HTTPException(422, "Supplier does not exist.")
            supplier = {"id": supplier_document["_id"], "name": supplier_document["name"]}
        try:
            database_call(
                request,
                "inventory-insert",
                lambda: request.app.state.inventory.insert_one(document.copy()),
            )
        except DuplicateKeyError:
            raise HTTPException(409, "An item with that SKU already exists.") from None
        return {**document, "supplier": supplier}

    @app.patch("/api/items/{sku}", response_model=Item)
    def update_stock(sku: str, update: StockUpdate, request: Request):
        document = database_call(
            request,
            "inventory-stock-update",
            lambda: request.app.state.inventory.find_one_and_update(
                {"sku": sku.upper()},
                {"$set": {"stock": update.stock, "updated_at": datetime.now(timezone.utc)}},
                projection={"_id": 0}, return_document=ReturnDocument.AFTER,
            ),
        )
        if document is None:
            raise HTTPException(404, "Item not found.")
        return document

    @app.delete("/api/items/{sku}", status_code=204)
    def delete_item(sku: str, request: Request):
        result = database_call(
            request,
            "inventory-delete",
            lambda: request.app.state.inventory.delete_one({"sku": sku.upper()}),
        )
        if result.deleted_count == 0:
            raise HTTPException(404, "Item not found.")
        return Response(status_code=204)

    @app.get("/api/admin/overview")
    def admin_overview(request: Request):
        """Return a read-only dashboard view derived from persisted evidence."""
        now = datetime.now(timezone.utc)
        run_id = os.getenv("DEMO_RUN_ID", "local")
        workload_filter = {
            "demo_run_id": run_id,
            "event": "request.completed",
            "http_method": "GET",
            "http_route": "/api/items",
        }
        recent_filter = {**workload_filter, "timestamp": {"$gte": now - timedelta(minutes=1)}}
        service_filter = {**workload_filter, "timestamp": {"$gte": now - timedelta(minutes=5)}}

        minute_logs = database_call(
            request,
            "telemetry-recent-window",
            lambda: list(request.app.state.evidence.logs.find(recent_filter, {"_id": 0})),
        )

        service_rows = database_call(
            request,
            "telemetry-service-window",
            lambda: list(request.app.state.evidence.logs.aggregate([
                {"$match": service_filter},
                {"$group": {
                    "_id": "$service",
                    "request_count": {"$sum": 1},
                    "error_count": {"$sum": {"$cond": [{"$gte": ["$status_code", 500]}, 1, 0]}},
                    "average_latency_ms": {"$avg": "$duration_ms"},
                    "last_seen_at": {"$max": "$timestamp"},
                }},
                {"$sort": {"_id": 1}},
            ])),
        )

        activity = database_call(
            request,
            "telemetry-recent-activity",
            lambda: list(
                request.app.state.evidence.logs.find(workload_filter, {"_id": 0})
                .sort("timestamp", -1)
                .limit(20)
            ),
        )

        active_incidents = database_call(
            request,
            "active-incident-count",
            lambda: request.app.state.evidence.incidents.count_documents(
                {"demo_run_id": run_id, "state": {"$ne": "resolved"}}
            ),
        )
        incidents = database_call(
            request,
            "active-incident-list",
            lambda: list(
                request.app.state.evidence.incidents.find(
                    {"demo_run_id": run_id, "state": {"$ne": "resolved"}}, {"_id": 0}
                ).sort("created_at", -1).limit(10)
            ),
        )

        services = []
        for row in service_rows:
            error_rate = row["error_count"] / row["request_count"]
            services.append({
                "id": row["_id"],
                "name": row["_id"].replace("_", " ").title(),
                "status": "degraded" if error_rate > 0.01 else "healthy",
                "request_count": row["request_count"],
                "error_rate": error_rate,
                "average_latency_ms": round(row["average_latency_ms"], 2),
                "last_seen_at": row["last_seen_at"],
            })

        average_latency = (
            round(sum(record["duration_ms"] for record in minute_logs) / len(minute_logs), 2)
            if minute_logs else None
        )
        return {
            "generated_at": now,
            "demo_run_id": run_id,
            "summary": {
                "active_incidents": active_incidents,
                "healthy_services": sum(service["status"] == "healthy" for service in services),
                "average_latency_ms": average_latency,
                "requests_per_minute": len(minute_logs),
            },
            "services": services,
            "incidents": incidents,
            "activity": activity,
            "telemetry": {
                "dropped_record_count": request.app.state.telemetry.dropped_record_count,
                "write_failure_count": request.app.state.telemetry.write_failure_count,
            },
        }

    @app.get("/api/incidents")
    def list_incidents(
        request: Request,
        state: Literal["open", "investigating", "diagnosed", "resolved", "all"] = "open",
        limit: int = Query(default=50, ge=1, le=100),
    ):
        run_id = os.getenv("DEMO_RUN_ID", "local")
        filters = {"demo_run_id": run_id}
        if state != "all":
            filters["state"] = state
        documents = database_call(
            request,
            "incident-list",
            lambda: list(
                request.app.state.evidence.incidents.find(filters, {
                    "_id": 0,
                    "id": 1,
                    "service": 1,
                    "route": 1,
                    "deployment_id": 1,
                    "git_sha": 1,
                    "state": 1,
                    "severity": 1,
                    "rule": 1,
                    "summary": 1,
                    "created_at": 1,
                    "updated_at": 1,
                }).sort("created_at", -1).limit(limit)
            ),
        )
        for document in documents:
            document["handoff_url"] = f"/api/incidents/{document['id']}"
        return {
            "demo_run_id": run_id,
            "state": state,
            "count": len(documents),
            "incidents": documents,
        }

    @app.get("/api/incidents/{incident_id}")
    def incident_detail(incident_id: str, request: Request):
        incident = database_call(
            request,
            "incident-by-id",
            lambda: request.app.state.evidence.incidents.find_one(
                {"_id": incident_id, "demo_run_id": os.getenv("DEMO_RUN_ID", "local")},
                {"_id": 0},
            ),
        )
        if incident is None:
            raise HTTPException(404, "Incident not found.")
        return incident

    @app.post("/api/incidents/{incident_id}/claim")
    def claim_incident(
        incident_id: str,
        claim: IncidentClaimRequest,
        request: Request,
    ):
        """Atomically assign one open incident to one investigation worker."""
        run_id = os.getenv("DEMO_RUN_ID", "local")
        now = datetime.now(timezone.utc)
        incident = database_call(
            request,
            "incident-claim",
            lambda: request.app.state.evidence.incidents.find_one_and_update(
                {"_id": incident_id, "demo_run_id": run_id, "state": "open"},
                {
                    "$set": {
                        "state": "investigating",
                        "claimed_by": claim.agent_id,
                        "claimed_at": now,
                        "updated_at": now,
                    },
                    "$inc": {"claim_count": 1},
                },
                projection={"_id": 0},
                return_document=ReturnDocument.AFTER,
            ),
        )
        if incident is not None:
            return incident

        existing = database_call(
            request,
            "incident-claim-conflict-check",
            lambda: request.app.state.evidence.incidents.find_one(
                {"_id": incident_id, "demo_run_id": run_id}, {"state": 1}
            ),
        )
        if existing is None:
            raise HTTPException(404, "Incident not found.")
        raise HTTPException(409, "Incident is no longer open.")

    @app.get(
        "/api/incidents/{incident_id}/investigations",
        response_model=list[Investigation],
    )
    def list_investigations(
        incident_id: str,
        request: Request,
        limit: int = Query(default=50, ge=1, le=100),
    ):
        run_id = os.getenv("DEMO_RUN_ID", "local")
        incident = database_call(
            request,
            "incident-exists",
            lambda: request.app.state.evidence.incidents.find_one(
                {"_id": incident_id, "demo_run_id": run_id}, {"_id": 1}
            ),
        )
        if incident is None:
            raise HTTPException(404, "Incident not found.")
        return database_call(
            request,
            "investigation-list",
            lambda: list(
                request.app.state.evidence.investigations.find(
                    {"demo_run_id": run_id, "incident_id": incident_id},
                    {"_id": 0, "schema_version": 0},
                ).sort("created_at", 1).limit(limit)
            ),
        )

    @app.post(
        "/api/incidents/{incident_id}/investigations",
        response_model=Investigation,
        status_code=201,
    )
    def create_investigation(
        incident_id: str,
        submission: InvestigationSubmission,
        request: Request,
    ):
        run_id = os.getenv("DEMO_RUN_ID", "local")
        incident = database_call(
            request,
            "incident-for-investigation",
            lambda: request.app.state.evidence.incidents.find_one(
                {"_id": incident_id, "demo_run_id": run_id}, {"state": 1}
            ),
        )
        if incident is None:
            raise HTTPException(404, "Incident not found.")
        if incident.get("state") == "resolved":
            raise HTTPException(409, "Resolved incidents do not accept new investigations.")

        # Match MongoDB's millisecond BSON precision so the create response is
        # byte-for-byte consistent with an immediate investigation read.
        current = datetime.now(timezone.utc)
        now = current.replace(microsecond=(current.microsecond // 1000) * 1000)
        investigation_id = f"investigation-{uuid4().hex[:12]}"
        document = {
            "_id": investigation_id,
            "id": investigation_id,
            "schema_version": 1,
            "demo_run_id": run_id,
            "incident_id": incident_id,
            "created_at": now,
            **submission.model_dump(),
        }
        database_call(
            request,
            "investigation-insert",
            lambda: request.app.state.evidence.investigations.insert_one(document.copy()),
        )
        incident_state = {
            "in_progress": "investigating",
            "completed": "diagnosed",
            "failed": incident.get("state", "open"),
        }[submission.status]
        database_call(
            request,
            "incident-investigation-update",
            lambda: request.app.state.evidence.incidents.update_one(
                {"_id": incident_id, "demo_run_id": run_id},
                {
                    "$set": {
                        "state": incident_state,
                        "updated_at": now,
                        "latest_investigation_id": investigation_id,
                    },
                    "$inc": {"investigation_count": 1},
                },
            ),
        )
        document.pop("_id")
        document.pop("schema_version")
        return document

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(ROOT / "frontend" / "index.html")

    @app.get("/admin", include_in_schema=False)
    def admin_dashboard():
        return FileResponse(ROOT / "frontend" / "admin.html")

    app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
    return app


app = create_app()
