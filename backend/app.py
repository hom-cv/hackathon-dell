import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo import MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError

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


def create_app(uri: str | None = None, database: str | None = None) -> FastAPI:
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
            yield
        finally:
            client.close()

    app = FastAPI(title="Blackbox Inventory API", lifespan=lifespan)
    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=origins,
            allow_methods=["GET", "POST", "PATCH"], allow_headers=["Content-Type"],
        )

    @app.exception_handler(PyMongoError)
    async def database_error(_request: Request, exc: PyMongoError):
        logger.error("MongoDB operation failed: %s", type(exc).__name__)
        return JSONResponse(status_code=503, content={"detail": "Database unavailable. Try again shortly."})

    @app.get("/healthz", include_in_schema=False)
    @app.get("/api/health")
    def health(request: Request):
        request.app.state.inventory.find_one({}, {"_id": 1})
        return {"status": "ok", "database": "connected"}

    @app.get("/api/items", response_model=list[Item])
    def list_items(request: Request):
        return list(request.app.state.inventory.find({}, {"_id": 0}).sort("sku", 1))

    @app.post("/api/items", response_model=Item, status_code=201)
    def create_item(item: NewItem, request: Request):
        now = datetime.now(timezone.utc)
        document = {**item.model_dump(), "created_at": now, "updated_at": now}
        try:
            request.app.state.inventory.insert_one(document.copy())
        except DuplicateKeyError:
            raise HTTPException(409, "An item with that SKU already exists.") from None
        return document

    @app.patch("/api/items/{sku}", response_model=Item)
    def update_stock(sku: str, update: StockUpdate, request: Request):
        document = request.app.state.inventory.find_one_and_update(
            {"sku": sku.upper()},
            {"$set": {"stock": update.stock, "updated_at": datetime.now(timezone.utc)}},
            projection={"_id": 0}, return_document=ReturnDocument.AFTER,
        )
        if document is None:
            raise HTTPException(404, "Item not found.")
        return document

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(ROOT / "frontend" / "index.html")

    app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
    return app


app = create_app()
