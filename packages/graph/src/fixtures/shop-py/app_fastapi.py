"""FastAPI-pattern fixture for the Python extractor (parsed, never imported)."""
from fastapi import FastAPI, APIRouter

from service import charge, list_items

app = FastAPI()
router = APIRouter(prefix="/api")


@router.get("/items/{sku}")
def get_item(sku: str):
    return list_items(sku)


@router.post("/checkout")
def checkout():
    return charge()


app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/dynamic")
def dynamic():
    handler = getattr(__import__("service"), "list_items")  # blind spot: no static edge
    return handler("x")
