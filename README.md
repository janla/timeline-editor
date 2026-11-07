# timeline-editor

A timeline editor for FastAPI apps. Clips go in one track: drag a clip's edges to trim it, drag the clip to move it, undo with Ctrl+Z (redo: Ctrl+Y), and export one video or the trimmed clips one by one. Trims snap to frames. Holds several timelines per data folder.

The backend is a FastAPI router. The frontend is a plain ES module plus a stylesheet, with no dependencies. Both are in this repo.

## Try it

`example/` runs the editor on a page of its own, with the clips from a folder:

1. Put video files in `example/clips/`. They are ordered by file name.
2. From the repo root, run `uv run example/app.py`. On the first run uv fetches FastAPI, uvicorn and an ffmpeg build.
3. Open http://127.0.0.1:8770.

Timelines and thumbnails are saved in `example/data/`, and exports in `example/exports/`. Git ignores the clips and both of those folders. The example loads the editor straight from this repo, so after changing the editor, restart the example and reload the page.

## Use it in an app

There are two ways. Pick one per app.

### As a package

The app installs it and imports `timeline_editor`:

```
uv add "timeline-editor @ git+https://github.com/janla/timeline-editor"
```

Updating: `uv lock --upgrade-package timeline-editor`, then `uv sync`.

Add the `ffmpeg` extra (`timeline-editor[ffmpeg]`) to get ffmpeg through imageio-ffmpeg. Otherwise ffmpeg must be on PATH, or set with `set_ffmpeg(path)`.

### As a git subtree (the code lives inside the app's repo)

The app keeps a copy of this repo in one of its folders, so it runs on its own and a plain clone works. Web2Video does this, with `web2video/timeline`:

```
git subtree add  --prefix=web2video/timeline https://github.com/janla/timeline-editor main --squash
git subtree pull --prefix=web2video/timeline https://github.com/janla/timeline-editor main --squash   # get updates
git subtree push --prefix=web2video/timeline https://github.com/janla/timeline-editor main            # send fixes back
```

The app then imports it relatively (`from . import timeline`). Run the commands from the app repo's root, with no uncommitted changes.

## Connect it

```python
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from timeline_editor import Source, make_router, set_ffmpeg, STATIC_DIR

class MyHost:
    def data_dir(self) -> Path:            # timelines.json, probe.json and thumbs/ go here
        return Path("data/timeline")
    def sources(self) -> list[Source]:     # the clips the editor may use, in their natural order
        return [Source(key=v.id, path=v.file, label=v.title) for v in my_videos()]

async def ask_path(kind: str, title: str, initial: str) -> str:
    """kind is "save" (a video file) or "folder". Return "" when cancelled."""
    ...

app.include_router(make_router(MyHost(), ask_path=ask_path), prefix="/api/timeline")
app.mount("/timeline", StaticFiles(directory=STATIC_DIR))
```

`data_dir()` and `sources()` are called on every request, so they can follow whichever project is open. Without `ask_path`, exporting answers 501, and everything else works.

`Source` fields: `key` (stable id of the slot a clip fills), `path`, `label`, and optionally `version` (change it when the slot gets new footage, and its trims start over), `name` (for export file names) and `group` (a second line on the clip).

On the page:

```html
<link rel="stylesheet" href="/timeline/timeline.css">
<script type="module">
  import { openTimeline } from '/timeline/timeline.js';
  button.onclick = () => openTimeline({ api: '/api/timeline', title: 'My project' });
</script>
```

`api` can also be an object shaped like `restApi()` in `timeline.js`, to talk to a backend other than this one.
