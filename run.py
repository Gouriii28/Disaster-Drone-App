"""
Start the SAADAXA server.

    python server/run.py

Uses HTTPS automatically when certs/cert.pem and certs/key.pem exist
(phones only allow camera, microphone and GPS on HTTPS pages).
"""
import logging
import os
import sys
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent
sys.path.insert(0, str(SERVER_DIR))
load_dotenv(SERVER_DIR / ".env")


class HideHarmlessDisconnects(logging.Filter):
    """On Windows, a browser closing a tab abruptly prints a long
    'ConnectionResetError [WinError 10054]' traceback. It is harmless,
    so it is hidden to keep the server window readable."""

    def filter(self, record):
        exc = record.exc_info[1] if record.exc_info else None
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError)):
            return False
        msg = record.getMessage()
        return "WinError 10054" not in msg and "_call_connection_lost" not in msg


logging.getLogger("asyncio").addFilter(HideHarmlessDisconnects())

host = os.getenv("HOST", "0.0.0.0")
port = int(os.getenv("PORT", "8443"))
cert = ROOT_DIR / "certs" / "cert.pem"
key = ROOT_DIR / "certs" / "key.pem"

kwargs = {}
if cert.exists() and key.exists():
    kwargs = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    scheme = "https"
else:
    scheme = "http"
    print("NOTE: no certificate found in certs/ - running plain HTTP.")
    print("      Camera, microphone and GPS will only work on this computer (localhost).")
    print("      Run  python scripts/make_cert.py  to enable phone access.\n")

print("SAADAXA server starting on {}://{}:{}".format(scheme, host, port))
print("Press Ctrl+C to stop.\n")
uvicorn.run("main:app", host=host, port=port, app_dir=str(SERVER_DIR),
            timeout_graceful_shutdown=2, **kwargs)
