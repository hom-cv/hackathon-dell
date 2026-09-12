import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter
from urllib.parse import quote_plus
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

from backend.telemetry import TelemetryWriter

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
logger = logging.getLogger(__name__)


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

    @field_validator("sku")
    @classmethod
    def normalize_sku(cls, value: str) -> str:
        return value.upper()


class StockUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stock: int = Field(ge=0, le=1_000_000, strict=True)


class Item(NewItem):
    created_at: datetime
    updated_at: datetime


SEED_ITEMS = [
    {"sku": "KEY-001", "name": "Mechanical keyboard", "stock": 24},
    {"sku": "MOU-002", "name": "Wireless mouse", "stock": 8},
    {"sku": "HUB-003", "name": "USB-C hub", "stock": 0},
    {"sku": "CAB-004", "name": "USB-C cable", "stock": 52},
    {"sku": "AUD-005", "name": "Studio headphones", "stock": 16},
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
            collection = client[database or os.getenv("MONGO_DATABASE", "shop")].inventory
            collection.create_index("sku", unique=True)
            now = datetime.now(timezone.utc)
            for item in SEED_ITEMS:
                collection.update_one(
                    {"sku": item["sku"]},
                    {"$setOnInsert": {**item, "created_at": now, "updated_at": now}},
                    upsert=True,
                )
            app.state.mongo = client
            app.state.inventory = collection
            evidence = client[telemetry_database or os.getenv("TELEMETRY_DATABASE", "blackbox")]
            logs = evidence.logs
            logs.create_index([("demo_run_id", 1), ("service", 1), ("timestamp", -1)])
            logs.create_index("trace_id")
            queue_size = max(1, int(os.getenv("TELEMETRY_QUEUE_SIZE", "10000")))
            app.state.telemetry = TelemetryWriter(logs, queue_size=queue_size)
            app.state.evidence = evidence
            app.state.telemetry.start()
            yield
        finally:
            if telemetry := getattr(app.state, "telemetry", None):
                telemetry.close()
            client.close()

    app = FastAPI(title="Blackbox Inventory API", lifespan=lifespan)
    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins,
            allow_methods=["GET", "POST", "PATCH"], allow_headers=["Content-Type"],
        )

    @app.middleware("http")
    async def record_request(request: Request, call_next):
        if not (request.url.path.startswith("/api/") or request.url.path == "/healthz"):
            return await call_next(request)

        trace_id = request.headers.get("x-trace-id") or uuid4().hex
        request.state.db_query_count = 0
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
        request.state.db_query_count += 1
        request.app.state.inventory.find_one({}, {"_id": 1})
        return {"status": "ok", "database": "connected"}

    @app.get("/api/items", response_model=list[Item])
    def list_items(request: Request):
        request.state.db_query_count += 1
        return list(request.app.state.inventory.find({}, {"_id": 0}).sort("sku", 1))

    @app.post("/api/items", response_model=Item, status_code=201)
    def create_item(item: NewItem, request: Request):
        now = datetime.now(timezone.utc)
        document = {**item.model_dump(), "created_at": now, "updated_at": now}
        try:
            request.state.db_query_count += 1
            request.app.state.inventory.insert_one(document.copy())
        except DuplicateKeyError:
            raise HTTPException(409, "An item with that SKU already exists.") from None
        return document

    @app.patch("/api/items/{sku}", response_model=Item)
    def update_stock(sku: str, update: StockUpdate, request: Request):
        request.state.db_query_count += 1
        document = request.app.state.inventory.find_one_and_update(
            {"sku": sku.upper()},
            {"$set": {"stock": update.stock, "updated_at": datetime.now(timezone.utc)}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if document is None:
            raise HTTPException(404, "Item not found.")
        return document

    @app.get("/api/admin/overview")
    def admin_overview(request: Request):
        """Return a read-only dashboard view derived from persisted evidence."""
        now = datetime.now(timezone.utc)
        run_id = os.getenv("DEMO_RUN_ID", "local")
        workload_filter = {
            "demo_run_id": run_id,
            "http_route": {"$nin": ["/api/health", "/api/admin/overview", "/healthz"]},
        }
        recent_filter = {**workload_filter, "timestamp": {"$gte": now - timedelta(minutes=1)}}
        service_filter = {**workload_filter, "timestamp": {"$gte": now - timedelta(minutes=5)}}

        request.state.db_query_count += 1
        minute_logs = list(request.app.state.evidence.logs.find(recent_filter, {"_id": 0}))

        request.state.db_query_count += 1
        service_rows = list(request.app.state.evidence.logs.aggregate([
            {"$match": service_filter},
            {"$group": {
                "_id": "$service",
                "request_count": {"$sum": 1},
                "error_count": {"$sum": {"$cond": [{"$gte": ["$status_code", 500]}, 1, 0]}},
                "average_latency_ms": {"$avg": "$duration_ms"},
                "last_seen_at": {"$max": "$timestamp"},
            }},
            {"$sort": {"_id": 1}},
        ]))

        request.state.db_query_count += 1
        activity = list(
            request.app.state.evidence.logs.find(workload_filter, {"_id": 0})
            .sort("timestamp", -1)
            .limit(20)
        )

        request.state.db_query_count += 1
        active_incidents = request.app.state.evidence.incidents.count_documents(
            {"demo_run_id": run_id, "state": {"$ne": "resolved"}}
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
            "activity": activity,
            "telemetry": {
                "dropped_record_count": request.app.state.telemetry.dropped_record_count,
                "write_failure_count": request.app.state.telemetry.write_failure_count,
            },
        }

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(ROOT / "frontend" / "index.html")

    @app.get("/admin", include_in_schema=False)
    def admin_dashboard():
        return FileResponse(ROOT / "frontend" / "admin.html")

    app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
    return app


app = create_app()
