"""Supervised job wrapper of the fixed-input evaluator (FE-2, ``fixed-eval-closure-v1``).

``python -m robot_quant.fixed_eval_job`` runs ONE evaluation step and speaks the same
framing as ``research_chunk``. It adds no engine code: it reads one request, calls
``fixed_eval.evaluate_fixed`` unchanged and writes one frame.

Request (one JSON object, same exact keys as the ``fixed_eval`` driver)::

    {"contract": {..., "rows": [...]}, "parameters": {...}, "kind": "EVALUATION" | "EVALUATION_STRESS",
     "split": {"warmup": int, "end": int}}

Frames (one canonical JSON object and a line feed on stdout):

- success: ``{"checkpoint": null, "result": <fixed_eval result>}``. The two keys are the
  frame the terminal reader accepts. A step has no mid-step checkpoint, so it is null.
- failure: ``{"error": "<UPPER_CASE_CODE>"}`` and exit status 1. No message, path or
  traceback leaves the process.

Transport follows ``research_chunk``:

- Without ``QUANT_IO_TERMINAL_PROTOCOL`` the request is the whole of stdin until EOF.
- With ``QUANT_IO_TERMINAL_PROTOCOL=quant-io-terminal-v1`` the four ``QUANT_IO_READY_*``
  variables are required, I/O telemetry is primed first, the request is one line, the
  frame is flushed, and the process then waits for exactly one terminal ACK line and EOF.
  A missing or wrong ACK exits 1 and leaves the already sent frame in place.

Identity: ``contract.engine_hash`` (the ``fixed-eval-closure-v1`` hash) and
``contract.dataset_sha256`` are required lower-case SHA-256 hex. ``fixed_eval`` echoes them
unchanged; the caller compares the echo with the frozen contract. A search field anywhere in
the request is refused before anything else is read, with ``QR4_EVALUATION_SEARCH_REFUSED``.
"""

import json
import os
import re
import sys
from decimal import InvalidOperation

from robot_quant import fixed_eval
from robot_quant.research_chunk import prepare_io_telemetry

IPC_LIMIT = 8 * 1024 * 1024
TERMINAL_PROTOCOL = "quant-io-terminal-v1"
TERMINAL_ACK = b"QUANT_IO_TERMINAL_ACK_V1\n"
READINESS = (
    "QUANT_IO_READY_FILE",
    "QUANT_IO_READY_DEVICE",
    "QUANT_IO_READY_RBPS",
    "QUANT_IO_READY_WBPS",
)
RESPONSE_TOO_LARGE = "FIXED_EVAL_RESPONSE_TOO_LARGE"
REQUEST_TOO_LARGE = "FIXED_EVAL_REQUEST_TOO_LARGE"
_HEX64 = re.compile(r"[0-9a-f]{64}")


def evaluate_request(request: object) -> dict:
    """Validate the request frame and run the evaluator once. Pure: no file, clock or network."""
    fixed_eval._refuse_search(request)
    request = fixed_eval._exact_keys(request, fixed_eval._REQUEST_KEYS, [], "request")
    contract = request["contract"]
    if not isinstance(contract, dict):
        raise fixed_eval._invalid("contract")
    for key in ("engine_hash", "dataset_sha256"):
        value = contract.get(key)
        if not isinstance(value, str) or _HEX64.fullmatch(value) is None:
            raise fixed_eval._invalid("contract." + key)
    return fixed_eval.evaluate_fixed(
        contract, request["parameters"], request["kind"], request["split"]
    )


def _frame(result: dict) -> bytes:
    try:
        text = json.dumps(
            {"checkpoint": None, "result": result},
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except Exception:
        raise ValueError(fixed_eval.FAILED) from None
    encoded = text.encode() + b"\n"
    if len(encoded) > IPC_LIMIT:
        raise ValueError(RESPONSE_TOO_LARGE)
    return encoded


def _error_frame(code: str) -> bytes:
    return b'{"error":"' + code.encode() + b'"}\n'


def _read(protocol: str | None) -> object:
    if protocol:
        raw = sys.stdin.buffer.readline(IPC_LIMIT + 2)
        if len(raw) > IPC_LIMIT + 1:
            raise ValueError(REQUEST_TOO_LARGE)
        if not raw.endswith(b"\n") or len(raw) == 1:
            raise fixed_eval._invalid("request.json")
    else:
        raw = sys.stdin.buffer.read(IPC_LIMIT + 1)
        if len(raw) > IPC_LIMIT:
            raise ValueError(REQUEST_TOO_LARGE)
    try:
        return json.loads(raw, parse_constant=fixed_eval._refuse_constant)
    except (ValueError, RecursionError):
        raise fixed_eval._invalid("request.json") from None


def main() -> None:
    sent = False
    try:
        protocol = os.environ.get("QUANT_IO_TERMINAL_PROTOCOL")
        if protocol is not None and (
            protocol != TERMINAL_PROTOCOL or not all(os.environ.get(name) for name in READINESS)
        ):
            raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
        prepare_io_telemetry()
        frame = _frame(evaluate_request(_read(protocol)))
        sys.stdout.buffer.write(frame)
        if protocol:
            sys.stdout.buffer.flush()
            sent = True
            if sys.stdin.buffer.readline(64) != TERMINAL_ACK or sys.stdin.buffer.read(1) != b"":
                raise ValueError("QUANT_IO_TERMINAL_ACK_REQUIRED")
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        InvalidOperation,
        OverflowError,
        RecursionError,
    ) as error:
        if not sent:
            sys.stdout.buffer.write(_error_frame(fixed_eval._error_code(error)))
        sys.stdout.buffer.flush()
        raise SystemExit(1) from None
    except Exception:  # Backstop: never a message or traceback, only the generic code.
        if not sent:
            sys.stdout.buffer.write(_error_frame(fixed_eval.FAILED))
        sys.stdout.buffer.flush()
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
