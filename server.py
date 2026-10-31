"""The timeline API: timelines of trimmed clips, their thumbnails and exports.

The host app says where the data lives and which clips exist (see `Host`); everything else is here.

    <data dir>/timelines.json   the timelines: clip order and trims
               probe.json       duration and frame rate of each clip file, so they are read once
               thumbs/          first and last frame of every trimmed clip
"""
import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Protocol

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import media


@dataclass
class Source:
    """A clip the host offers for timelines."""
    key: str           # stable id of the slot the clip fills (e.g. the image it was rendered from)
    path: Path         # the video file
    label: str         # shown on the clip
    version: str = ""  # changes when the slot gets other footage: the clip's trims start over then
    name: str = ""     # for export file names; the label when empty
    group: str = ""    # optional second line on the clip


class Host(Protocol):
    def data_dir(self) -> Path: ...
    def sources(self) -> list[Source]: ...


# Asks the user for a path: kind is "save" (a video file) or "folder". Returns "" when cancelled.
AskPath = Callable[[str, str, str], Awaitable[str]]


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _new_timeline(name: str, auto: bool = True, clips: list | None = None) -> dict:
    return {"id": uuid.uuid4().hex[:12], "name": name, "auto": auto, "rev": 1, "clips": clips or []}


def _vtag(src: Source) -> str:
    return hashlib.sha1(f"{src.version}|{src.path.name}".encode()).hexdigest()[:10]


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", s).strip("-")[:48] or "clip"


def frames(clip: dict) -> tuple[int, int]:
    """First frame and the frame after the last, of a trimmed clip."""
    fps = clip["fps"]
    a = round(clip["in"] * fps)
    return a, max(a + 1, round(clip["out"] * fps))


class TimelineStore:
    """The timelines of one data dir (one project)."""

    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.path = data_dir / "timelines.json"
        self.thumbs = data_dir / "thumbs"
        self.probe_path = data_dir / "probe.json"
        self.lock = asyncio.Lock()
        self.doc = self._load()
        self.probes: dict = _read_json(self.probe_path, {})

    def _load(self) -> dict:
        doc = _read_json(self.path, None)
        if not isinstance(doc, dict) or not doc.get("timelines"):
            doc = {"version": 1, "timelines": [_new_timeline("Timeline 1")], "export": {}}
        doc.setdefault("export", {})
        return doc

    def save(self) -> None:
        _write_json(self.path, self.doc)

    def get(self, tid: str) -> dict:
        for t in self.doc["timelines"]:
            if t["id"] == tid:
                return t
        raise HTTPException(404, "no such timeline")

    async def probe(self, path: Path) -> dict:
        st = path.stat()
        key = f"{path.name}|{st.st_size}|{int(st.st_mtime)}"
        if key not in self.probes:
            p = await media.probe(path)
            self.probes[key] = {"duration": p.duration, "fps": p.fps, "width": p.width,
                                "height": p.height, "audio": p.audio}
            _write_json(self.probe_path, self.probes)
        return self.probes[key]

    async def reconcile(self, t: dict, sources: list[Source]) -> bool:
        """Bring a timeline up to date with the clips the host offers. Returns True when it changed."""
        by_key = {s.key: s for s in sources}
        changed = False
        clips = []
        for c in t["clips"]:
            src = by_key.get(c["key"])
            if not src:
                changed = True  # the slot is gone (image removed, file deleted)
                continue
            if c.get("version") != src.version or "duration" not in c:
                try:
                    info = await self.probe(src.path)
                except (OSError, ValueError):
                    changed = True
                    continue
                c.update(version=src.version, duration=info["duration"], fps=info["fps"],
                         **{"in": 0.0, "out": info["duration"]})
                changed = True
            clips.append(c)
        if t.get("auto"):
            # New clips go after the clip of the slot before them in the host's order, else first.
            present = {c["key"] for c in clips}
            order = [s.key for s in sources]
            for i, s in enumerate(sources):
                if s.key in present:
                    continue
                try:
                    info = await self.probe(s.path)
                except (OSError, ValueError):
                    continue
                at = 0
                for prev in reversed(order[:i]):
                    if prev in present:
                        at = next(j for j, c in enumerate(clips) if c["key"] == prev) + 1
                        break
                clips.insert(at, {"id": uuid.uuid4().hex[:12], "key": s.key, "version": s.version,
                                  "duration": info["duration"], "fps": info["fps"],
                                  "in": 0.0, "out": info["duration"]})
                present.add(s.key)
                changed = True
        if changed:
            t["clips"] = clips
            t["rev"] = t.get("rev", 0) + 1
        return changed

    def thumb_name(self, key: str, vtag: str, frame: int) -> str:
        return f"{_slug(key)}_{vtag}_{frame}.jpg"

    def prune_thumbs(self, sources: list[Source]) -> None:
        """Keep the first and last frame of every clip in every timeline; drop older trims."""
        if not self.thumbs.is_dir():
            return
        by_key = {s.key: s for s in sources}
        keep = set()
        for t in self.doc["timelines"]:
            for c in t["clips"]:
                src = by_key.get(c["key"])
                if src and "fps" in c:
                    a, b = frames(c)
                    keep |= {self.thumb_name(c["key"], _vtag(src), f) for f in (a, b - 1)}
        for f in self.thumbs.glob("*.jpg"):
            if f.name not in keep:
                f.unlink(missing_ok=True)


class ClipIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    key: str
    in_: float = Field(0, alias="in")
    out: float = 0


class TimelinePut(BaseModel):
    rev: int
    name: str | None = None
    clips: list[ClipIn]


class TimelineNew(BaseModel):
    name: str = ""
    copy_of: str = ""


class ExportReq(BaseModel):
    mode: str = "video"  # "video": one file; "clips": every trimmed clip as a file of its own


def make_router(host: Host, ask_path: AskPath | None = None, thumb_height: int = 144) -> APIRouter:
    """The API for the timeline editor. Mount it where the page's `api` option points."""
    router = APIRouter()
    stores: dict[Path, TimelineStore] = {}
    thumb_gate = asyncio.Semaphore(4)  # a timeline of 100 clips asks for 200 thumbnails at once
    exports: dict[str, dict] = {}

    def store() -> TimelineStore:
        d = host.data_dir().resolve()
        if d not in stores:
            stores[d] = TimelineStore(d)
        return stores[d]

    def sources() -> list[Source]:
        return [s for s in host.sources() if s.path.is_file()]

    def view(t: dict, srcs: list[Source]) -> dict:
        by_key = {s.key: s for s in srcs}
        clips = []
        for c in t["clips"]:
            s = by_key[c["key"]]
            clips.append({**c, "label": s.label, "group": s.group, "vtag": _vtag(s)})
        return {"id": t["id"], "name": t["name"], "auto": t.get("auto", False), "rev": t["rev"], "clips": clips}

    def summary(t: dict) -> dict:
        return {"id": t["id"], "name": t["name"], "clips": len(t["clips"]),
                "duration": sum(c["out"] - c["in"] for c in t["clips"] if "out" in c)}

    async def fresh(st: TimelineStore, t: dict) -> dict:
        srcs = sources()
        if await st.reconcile(t, srcs):
            st.save()
            st.prune_thumbs(srcs)
        return view(t, srcs)

    @router.get("")
    async def list_timelines():
        st = store()
        return {"timelines": [summary(t) for t in st.doc["timelines"]], "export": st.doc["export"]}

    @router.post("")
    async def new_timeline(req: TimelineNew):
        st = store()
        async with st.lock:
            n = len(st.doc["timelines"]) + 1
            name = req.name.strip() or f"Timeline {n}"
            if req.copy_of:
                base = st.get(req.copy_of)
                clips = [{**c, "id": uuid.uuid4().hex[:12]} for c in base["clips"]]
                t = _new_timeline(name, base.get("auto", True), clips)
            else:
                t = _new_timeline(name)
            st.doc["timelines"].append(t)
            out = await fresh(st, t)
            st.save()
        return out

    @router.get("/media/{key}")
    async def clip_media(key: str):
        src = next((s for s in sources() if s.key == key), None)
        if not src:
            raise HTTPException(404, "clip not found")
        return FileResponse(src.path, headers={"Cache-Control": "no-cache"})

    @router.get("/thumb/{key}")
    async def thumb(key: str, f: int = 0):
        st = store()
        src = next((s for s in sources() if s.key == key), None)
        if not src:
            raise HTTPException(404, "clip not found")
        vtag = _vtag(src)
        path = st.thumbs / st.thumb_name(key, vtag, max(f, 0))
        if not path.is_file():
            info = await st.probe(src.path)
            st.thumbs.mkdir(parents=True, exist_ok=True)
            async with thumb_gate:
                if not path.is_file():
                    # Half a frame early: ffmpeg takes the first frame at or after the time given.
                    t = min((max(f, 0) - 0.5) / info["fps"], info["duration"] - 0.5 / info["fps"])
                    try:
                        await media.thumbnail(src.path, t, path, thumb_height)
                    except (RuntimeError, media.FFmpegMissing) as e:
                        raise HTTPException(500, f"thumbnail failed: {e}")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @router.get("/{tid}")
    async def get_timeline(tid: str):
        st = store()
        async with st.lock:
            return await fresh(st, st.get(tid))

    @router.put("/{tid}")
    async def put_timeline(tid: str, req: TimelinePut):
        st = store()
        async with st.lock:
            t = st.get(tid)
            if req.rev != t["rev"]:
                raise HTTPException(409, "The timeline changed meanwhile (new clips, or another window).")
            old = {c["id"]: c for c in t["clips"]}
            clips = []
            for c in req.clips:
                cur = old.pop(c.id, None)
                if not cur or cur["key"] != c.key:
                    raise HTTPException(400, f"unknown clip {c.id}")
                fps, dur = cur["fps"], cur["duration"]
                # Trims sit on frame boundaries; at least two frames stay.
                a = max(0, min(round(c.in_ * fps), round(dur * fps) - 2))
                b = max(a + 2, min(round(c.out * fps), round(dur * fps)))
                clips.append({**cur, "in": a / fps, "out": min(b / fps, dur)})
            t["clips"] = clips
            if req.name is not None and req.name.strip():
                t["name"] = req.name.strip()
            t["rev"] += 1
            st.save()
            st.prune_thumbs(sources())
            return await fresh(st, t)

    @router.delete("/{tid}")
    async def delete_timeline(tid: str):
        st = store()
        async with st.lock:
            t = st.get(tid)
            if len(st.doc["timelines"]) < 2:
                raise HTTPException(400, "The last timeline stays.")
            st.doc["timelines"].remove(t)
            st.save()
            st.prune_thumbs(sources())
        return {"deleted": True}

    # ---------- export ----------

    @router.post("/{tid}/export")
    async def start_export(tid: str, req: ExportReq):
        st = store()
        async with st.lock:
            t = await fresh(st, st.get(tid))
        if not t["clips"]:
            raise HTTPException(400, "The timeline has no clips.")
        if any(e["state"] == "running" for e in exports.values()):
            raise HTTPException(409, "An export is already running.")
        if not ask_path:
            raise HTTPException(501, "This app has no file dialog for exports.")
        last = st.doc["export"].get("dir", "")
        if req.mode == "clips":
            target = await ask_path("folder", "Export the clips to…", last)
        else:
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", t["name"]).strip() or "timeline"
            target = await ask_path("save", "Export the timeline as…", str(Path(last) / f"{name}.mp4") if last else f"{name}.mp4")
        if not target:
            return {"cancelled": True}
        st.doc["export"].update(dir=target if req.mode == "clips" else str(Path(target).parent), mode=req.mode)
        st.save()

        by_key = {s.key: s for s in sources()}
        job = {"id": uuid.uuid4().hex[:10], "state": "running", "progress": 0.0, "target": target,
               "files": [], "error": "", "started": time.time()}
        exports[job["id"]] = job
        job["task"] = asyncio.create_task(run_export(st, job, t, by_key, req.mode, Path(target)))
        return {k: v for k, v in job.items() if k != "task"}

    async def run_export(st: TimelineStore, job: dict, t: dict, by_key: dict, mode: str, target: Path):
        cuts = []
        for c in t["clips"]:
            s = by_key.get(c["key"])
            if not s:
                continue
            info = await st.probe(s.path)
            a, b = frames(c)
            cuts.append((c, s, info, a, b))
        total = sum((b - a) / info["fps"] for _, _, info, a, b in cuts) or 1
        done = 0.0

        def progress(line: str):
            if line.startswith("out_time_us=") and line[12:].isdigit():
                job["progress"] = min(0.99, (done + int(line[12:]) / 1e6) / total)

        try:
            if mode == "clips":
                target.mkdir(parents=True, exist_ok=True)
                for i, (c, s, info, a, b) in enumerate(cuts, 1):
                    out = target / f"{i:02d}_{_slug(s.name or s.label)}{s.path.suffix.lower()}"
                    if a == 0 and b >= round(info["duration"] * info["fps"]):
                        await asyncio.to_thread(shutil.copy2, s.path, out)  # untrimmed: the file as it is
                    else:
                        fps = info["fps"]
                        cut = media.Cut(s.path, max(0, (a - 0.5) / fps), (b - 0.5) / fps, info["audio"], fps)
                        code, err = await media.run(media.cut_args(cut, out.with_suffix(".mp4")), progress)
                        if code != 0:
                            raise RuntimeError(err.strip()[-600:])
                        out = out.with_suffix(".mp4")
                    job["files"].append(str(out))
                    done += (b - a) / info["fps"]
                    job["progress"] = min(0.99, done / total)
            else:
                first = cuts[0][2]
                w, h = first["width"] or 1280, first["height"] or 720
                w, h = w - w % 2, h - h % 2
                mcuts = []
                for c, s, info, a, b in cuts:
                    fps = info["fps"]
                    mcuts.append(media.Cut(s.path, max(0, (a - 0.5) / fps), (b - 0.5) / fps, info["audio"], fps))
                out = target.with_suffix(".mp4")
                code, err = await media.run(media.concat_args(mcuts, w, h, first["fps"], out), progress)
                if code != 0:
                    raise RuntimeError(err.strip()[-600:])
                job["files"].append(str(out))
            job.update(state="done", progress=1.0)
        except asyncio.CancelledError:
            job.update(state="cancelled")
        except Exception as e:
            job.update(state="error", error=str(e) or type(e).__name__)

    @router.get("/exports/{job_id}")
    async def export_status(job_id: str):
        job = exports.get(job_id)
        if not job:
            raise HTTPException(404, "no such export")
        return {k: v for k, v in job.items() if k != "task"}

    @router.post("/exports/{job_id}/cancel")
    async def cancel_export(job_id: str):
        job = exports.get(job_id)
        if job and job["state"] == "running":
            job["task"].cancel()
        return {"ok": True}

    return router
