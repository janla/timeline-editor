# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "imageio-ffmpeg>=0.5"]
# ///
"""The timeline editor on a page of its own, for trying it out and working on it.

Put video files in example/clips/, then from the repo root:

    uv run example/app.py

and open http://127.0.0.1:8770. Clips are ordered by file name. Timelines and thumbnails go to
example/data/, exports to example/exports/. All three folders stay out of git.
"""
import importlib.util
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CLIPS = HERE / "clips"
DATA = HERE / "data"
EXPORTS = HERE / "exports"
VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}
PORT = 8770

# The repo root is the package folder. Load it from here as `timeline_editor`, so edits to the editor
# show up on the next start without installing anything.
spec = importlib.util.spec_from_file_location("timeline_editor", ROOT / "__init__.py",
                                              submodule_search_locations=[str(ROOT)])
timeline_editor = importlib.util.module_from_spec(spec)
sys.modules["timeline_editor"] = timeline_editor
spec.loader.exec_module(timeline_editor)


class FolderHost:
    """Every video file in clips/ is a clip."""

    def data_dir(self) -> Path:
        return DATA

    def sources(self) -> list:
        out = []
        for f in sorted(CLIPS.iterdir(), key=lambda p: p.name.lower()) if CLIPS.is_dir() else []:
            if f.is_file() and f.suffix.lower() in VIDEO:
                st = f.stat()
                # A file replaced under the same name gets a new version: its trims start over.
                out.append(timeline_editor.Source(key=f.name, path=f, label=f.stem, name=f.stem,
                                                  version=f"{st.st_size}-{int(st.st_mtime)}"))
        return out


async def ask_path(kind: str, title: str, initial: str) -> str:
    # No file dialog in a browser-only example: exports go to exports/ under the name the editor suggests.
    EXPORTS.mkdir(exist_ok=True)
    if kind == "folder":
        n = 1
        while (EXPORTS / f"clips-{n}").exists():
            n += 1
        return str(EXPORTS / f"clips-{n}")
    return str(EXPORTS / Path(initial).name)


app = FastAPI()
app.include_router(timeline_editor.make_router(FolderHost(), ask_path=ask_path), prefix="/api/timeline")
app.mount("/timeline", StaticFiles(directory=timeline_editor.STATIC_DIR), name="timeline")


@app.get("/api/info")
def info():
    return {"clips": len(FolderHost().sources()), "folder": str(CLIPS), "exports": str(EXPORTS)}


@app.get("/")
def page():
    return FileResponse(HERE / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    CLIPS.mkdir(exist_ok=True)
    print(f"Clips from {CLIPS}\nOpen http://127.0.0.1:{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
