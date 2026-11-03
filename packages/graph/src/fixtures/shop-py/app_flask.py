"""Flask-pattern fixture for the Python extractor (parsed, never imported)."""
from flask import Blueprint, Flask

from service import list_items

app = Flask(__name__)
bp = Blueprint("shop", __name__, url_prefix="/v1")


@bp.route("/items/<sku>", methods=["GET"])
def bp_get_item(sku):
    return list_items(sku)


@app.route("/legacy", methods=["GET", "POST"])
def legacy():
    return {"ok": True}


app.register_blueprint(bp)
