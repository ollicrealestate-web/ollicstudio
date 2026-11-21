"""Private local connection between the Ollic Sketch hub and Blender.

Listens on 127.0.0.1 only, one JSON line in and one JSON line out, the same protocol as the
Revit helper. Commands run on Blender's main thread through bpy.app.timers. Each running
Blender announces its port in %LOCALAPPDATA%\\OllicSketch\\instances\\blender-<pid>.json.
"""
import json
import os
import queue
import socket
import threading
import time
import traceback

import bpy

FIRST_PORT = 48904
_requests = queue.Queue()
_state = {"sock": None, "thread": None, "file": None, "stop": False, "port": None}


def _instances_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    d = os.path.join(base, "OllicSketch", "instances")
    os.makedirs(d, exist_ok=True)
    return d


def _handle_client(conn):
    with conn:
        f = conn.makefile("rwb")
        for raw in f:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                reply = {"ok": False, "error": "Unreadable request."}
            else:
                if req.get("tool") == "ping":
                    reply = {"ok": True, "result": {"app": "blender", "version": bpy.app.version_string}}
                else:
                    done = threading.Event()
                    box = {}
                    _requests.put((req, done, box))
                    if done.wait(timeout=6 * 60):
                        reply = box["reply"]
                    else:
                        reply = {"ok": False, "error": "Blender did not answer within 6 minutes. Close any open dialog in Blender and try again."}
            f.write((json.dumps(reply) + "\n").encode("utf-8"))
            f.flush()


def _accept_loop():
    s = _state["sock"]
    while not _state["stop"]:
        try:
            conn, _ = s.accept()
        except OSError:
            break
        threading.Thread(target=_handle_client, args=(conn,), daemon=True).start()


def _pump():
    """Runs on Blender's main thread: executes queued commands and advances render jobs."""
    from . import commands
    try:
        while True:
            req, done, box = _requests.get_nowait()
            try:
                result = commands.run(req.get("tool"), req.get("args") or {})
                box["reply"] = {"ok": True, "result": result}
            except Exception as e:  # report the reason in plain words, keep details for the log
                traceback.print_exc()
                box["reply"] = {"ok": False, "error": str(e) or e.__class__.__name__}
            done.set()
    except queue.Empty:
        pass
    try:
        busy = commands.step_jobs()
    except Exception:
        traceback.print_exc()
        busy = False
    return 0.01 if busy else 0.1


def start():
    if _state["sock"]:
        return
    sock = None
    for port in range(FIRST_PORT, FIRST_PORT + 20):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", port))
            sock.listen(8)
            _state["port"] = port
            break
        except OSError:
            sock.close()
            sock = None
    if sock is None:
        print("Ollic Sketch: no free local port between 48904 and 48923")
        return
    _state.update(sock=sock, stop=False)
    _state["file"] = os.path.join(_instances_dir(), f"blender-{os.getpid()}.json")
    with open(_state["file"], "w", encoding="utf-8") as fh:
        json.dump({"app": "blender", "version": bpy.app.version_string, "port": _state["port"], "pid": os.getpid(),
                   "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, fh)
    _state["thread"] = threading.Thread(target=_accept_loop, daemon=True)
    _state["thread"].start()
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, first_interval=0.5, persistent=True)
    print(f"Ollic Sketch: listening on 127.0.0.1:{_state['port']}")


def stop():
    _state["stop"] = True
    try:
        if _state["sock"]:
            _state["sock"].close()
    except OSError:
        pass
    _state["sock"] = None
    try:
        if _state["file"] and os.path.exists(_state["file"]):
            os.remove(_state["file"])
    except OSError:
        pass
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
