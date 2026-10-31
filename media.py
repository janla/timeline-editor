"""ffmpeg: probing clips, grabbing thumbnails and rendering exports.

The binary is found in this order: the path given to `set_ffmpeg()`, `ffmpeg` on PATH, the copy that
comes with the imageio-ffmpeg package.
"""
import asyncio
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

_ffmpeg: str | None = None


class FFmpegMissing(RuntimeError):
    pass


def set_ffmpeg(path: str | None) -> None:
    global _ffmpeg
    _ffmpeg = path or None


def ffmpeg() -> str:
    global _ffmpeg
    if _ffmpeg:
        return _ffmpeg
    found = shutil.which("ffmpeg")
    if not found:
        try:
            import imageio_ffmpeg
            found = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            found = None
    if not found:
        raise FFmpegMissing("ffmpeg not found: put it on PATH, install imageio-ffmpeg, or set its path.")
    _ffmpeg = found
    return found


async def run(args: list[str], on_line=None) -> tuple[int, str]:
    """Run ffmpeg. Returns (exit code, stderr). `on_line` gets each stdout line (for -progress)."""
    proc = await asyncio.create_subprocess_exec(
        ffmpeg(), "-hide_banner", "-nostdin", *args,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    async def read_out():
        async for raw in proc.stdout:
            if on_line:
                on_line(raw.decode(errors="replace").strip())

    try:
        _, err = await asyncio.gather(read_out(), proc.stderr.read())
        await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        raise
    return proc.returncode, err.decode(errors="replace")


@dataclass
class Probe:
    duration: float
    fps: float
    width: int
    height: int
    audio: bool


async def probe(path: Path) -> Probe:
    # ffmpeg alone (imageio-ffmpeg has no ffprobe): the stream summary it prints for -i is enough.
    _, err = await run(["-i", str(path)])
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if not m:
        raise ValueError(f"not a readable video: {path.name}")
    duration = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
    video = re.search(r"Stream #.*?Video:.*?(\d{2,5})x(\d{2,5})", err)
    fps = re.search(r"Stream #.*?Video:.*?([\d.]+) fps", err)
    return Probe(duration=duration, fps=float(fps[1]) if fps else 24.0,
                 width=int(video[1]) if video else 0, height=int(video[2]) if video else 0,
                 audio=bool(re.search(r"Stream #.*?Audio:", err)))


async def thumbnail(src: Path, t: float, dest: Path, height: int) -> None:
    tmp = dest.with_suffix(".tmp.jpg")
    code, err = await run(["-y", "-ss", f"{max(t, 0):.3f}", "-i", str(src), "-frames:v", "1",
                           "-vf", f"scale=-2:{height}", "-q:v", "4", str(tmp)])
    if code != 0 or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        raise RuntimeError(err.strip()[-300:] or "ffmpeg made no thumbnail")
    tmp.replace(dest)


@dataclass
class Cut:
    path: Path
    start: float
    end: float
    audio: bool
    fps: float = 0  # of the file; converted when it differs from the export's


ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]


def concat_args(cuts: list[Cut], width: int, height: int, fps: float, out: Path) -> list[str]:
    """One video from all cuts. Every cut is scaled and padded to the first clip's frame; a cut
    without sound gets silence, so the concat filter always has both streams."""
    args, chains, pairs = [], [], []
    for i, c in enumerate(cuts):
        args += ["-i", str(c.path)]
        chains.append(
            f"[{i}:v]trim=start={c.start:.4f}:end={c.end:.4f},setpts=PTS-STARTPTS,"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
            # Only where needed: the fps filter drops the last frame of every segment.
            + (f",fps={fps:g}" if c.fps and abs(c.fps - fps) > 0.01 else "") + f"[v{i}]")
        if c.audio:
            chains.append(f"[{i}:a]atrim=start={c.start:.4f}:end={c.end:.4f},asetpts=PTS-STARTPTS,"
                          f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]")
        else:
            chains.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={c.end - c.start:.4f}[a{i}]")
        pairs.append(f"[v{i}][a{i}]")
    graph = ";".join(chains) + f";{''.join(pairs)}concat=n={len(cuts)}:v=1:a=1[v][a]"
    return ["-y", *args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", *ENCODE,
            "-progress", "pipe:1", "-nostats", str(out)]


def cut_args(c: Cut, out: Path) -> list[str]:
    # -ss before -i with re-encoding is frame accurate and does not decode the skipped part.
    return ["-y", "-ss", f"{c.start:.4f}", "-i", str(c.path), "-t", f"{c.end - c.start:.4f}",
            "-map", "0:v:0", "-map", "0:a:0?", *ENCODE, "-progress", "pipe:1", "-nostats", str(out)]
