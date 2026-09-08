"""Mp3MetaApi entry point.

Run with (from this folder):
    .venv/bin/uvicorn main:app --reload --port 8000
or directly:
    .venv/bin/python main.py
"""
from app.api import create_app

app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)