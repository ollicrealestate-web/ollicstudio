"""Entry point for uvicorn: `uvicorn app.asgi:app` (settings come from the environment)."""

from .main import create_app

app = create_app()
