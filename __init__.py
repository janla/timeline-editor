"""Timeline editor: chain clips, trim their ends, reorder them, export the result.

Install it into a FastAPI app as the `timeline_editor` package (see pyproject.toml), or embed this repo
as a git subtree and import it relatively (see README.md):

    from pathlib import Path
    from fastapi.staticfiles import StaticFiles
    from timeline_editor import Source, make_router, STATIC_DIR

    class MyHost:
        def data_dir(self) -> Path: return Path("data/timeline")
        def sources(self) -> list[Source]:
            return [Source(key=v.id, path=v.file, label=v.title) for v in my_videos()]

    app.include_router(make_router(MyHost(), ask_path=my_dialog), prefix="/api/timeline")
    app.mount("/timeline", StaticFiles(directory=STATIC_DIR))

On the page:

    <link rel="stylesheet" href="/timeline/timeline.css">
    <script type="module">
      import { openTimeline } from '/timeline/timeline.js';
      button.onclick = () => openTimeline({ api: '/api/timeline' });
    </script>

Needs ffmpeg (PATH, imageio-ffmpeg, or `media.set_ffmpeg(path)`).
"""
from pathlib import Path

from .media import set_ffmpeg
from .server import Host, Source, TimelineStore, make_router

STATIC_DIR = Path(__file__).resolve().parent / "static"

__all__ = ["Host", "Source", "TimelineStore", "make_router", "set_ffmpeg", "STATIC_DIR"]
