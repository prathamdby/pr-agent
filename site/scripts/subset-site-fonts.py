#!/usr/bin/env python3

import sys
import tempfile
from dataclasses import dataclass
from importlib.metadata import version
from io import BytesIO
from pathlib import Path

import brotli
import fontTools
from fontTools.subset import Options, Subsetter, load_font, save_font
from fontTools.ttLib import TTFont

FONTTOOLS_VERSION = "4.68.0"
BROTLI_VERSION = "1.2.1"
LATIN_FLOOR = set(range(0x0180))
CONTROL_LIMIT = 0x20

SCAN_FILES = (
    "lib/content.ts",
    "lib/agentResources.ts",
    "lib/seo.ts",
    "lib/site.ts",
)


@dataclass(frozen=True)
class Face:
    family: str
    source_name: str
    output_name: str
    layout_features: tuple[str, ...]


FACES = (
    Face("Geist", "Geist-Variable.ttf", "Geist-Variable.woff2", ("ccmp", "liga", "kern", "tnum")),
    Face("Geist Mono", "GeistMono-Variable.ttf", "GeistMono-Variable.woff2", ("ccmp",)),
)


@dataclass(frozen=True)
class SubsetResult:
    family: str
    before: int
    after: int
    glyphs: int
    cmap: int
    data: bytes


def require_versions() -> None:
    imported_fonttools = fontTools.__version__
    imported_brotli = brotli.__version__
    if imported_fonttools != FONTTOOLS_VERSION or version("fonttools") != FONTTOOLS_VERSION:
        raise SystemExit(f"fontTools {imported_fonttools} != {FONTTOOLS_VERSION}")
    if imported_brotli != BROTLI_VERSION or version("brotli") != BROTLI_VERSION:
        raise SystemExit(f"brotli {imported_brotli} != {BROTLI_VERSION}")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeError as error:
        raise SystemExit(f"{path} is not utf-8: {error}") from error


def function_body(source: str, name: str) -> str:
    marker = f"function {name}"
    start = source.find(marker)
    if start < 0:
        raise SystemExit(f"{name} not found")
    open_at = source.find("{", start)
    if open_at < 0:
        raise SystemExit(f"{name} has no body")
    depth = 0
    for index in range(open_at, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_at : index + 1]
    raise SystemExit(f"{name} body is unbalanced")


def scanned_codepoints(site: Path) -> set[int]:
    texts = []
    components = site / "components"
    app = site / "app"
    if not components.is_dir() or not app.is_dir():
        raise SystemExit("site scan roots are missing")
    for path in sorted(components.rglob("*")):
        if path.is_file():
            texts.append(read_text(path))
    app_files = sorted(app.rglob("*.tsx"))
    if not app_files:
        raise SystemExit("site/app has no tsx files")
    for path in app_files:
        texts.append(read_text(path))
    for relative in SCAN_FILES:
        path = site / relative
        if not path.is_file():
            raise SystemExit(f"missing scan file {path}")
        texts.append(read_text(path))
    knowledge = site / "lib" / "llmsKnowledge.ts"
    if not knowledge.is_file():
        raise SystemExit(f"missing scan file {knowledge}")
    texts.append(function_body(read_text(knowledge), "llmsNudgeTitle"))
    return {ord(char) for text in texts for char in text if ord(char) >= CONTROL_LIMIT}


def unicode_cmap(font: TTFont, family: str) -> set[int]:
    cmap = font.getBestCmap()
    if not cmap:
        raise SystemExit(f"{family} has no Unicode cmap")
    return set(cmap)


def keep_unicodes(cmap: set[int], scanned: set[int], family: str) -> list[int]:
    missing = sorted(code for code in scanned if code not in cmap)
    if missing:
        for code in missing:
            print(f"U+{code:04X} missing from {family}", file=sys.stderr)
        raise SystemExit(1)
    return sorted((LATIN_FLOOR & cmap) | scanned)


def subset_face(face: Face, site: Path, scanned: set[int]) -> SubsetResult:
    source = site / "assets" / "fonts" / face.source_name
    output = site / "public" / "fonts" / face.output_name
    if not source.is_file() or not output.is_file():
        raise SystemExit(f"missing font for {face.family}")
    before = output.stat().st_size
    options = Options(
        layout_features=list(face.layout_features),
        glyph_names=True,
        hinting=True,
        notdef_outline=True,
        name_IDs=["*"],
        flavor="woff2",
    )
    font = load_font(source, options, dontLoadGlyphNames=False, lazy=options.lazy)
    unicodes = keep_unicodes(unicode_cmap(font, face.family), scanned, face.family)
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    buffer = BytesIO()
    save_font(font, buffer, options)
    data = buffer.getvalue()
    saved = TTFont(BytesIO(data))
    cmap = saved.getBestCmap()
    if not cmap:
        raise SystemExit(f"{face.family} subset has no Unicode cmap")
    return SubsetResult(face.family, before, len(data), saved["maxp"].numGlyphs, len(cmap), data)


def publish(site: Path, results: tuple[SubsetResult, ...]) -> None:
    staged: list[tuple[Path, Path, int, str]] = []
    try:
        for result, face in zip(results, FACES, strict=True):
            destination = site / "public" / "fonts" / face.output_name
            handle = tempfile.NamedTemporaryFile(
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            )
            temporary = Path(handle.name)
            staged.append((temporary, destination, result.after, face.family))
            with handle:
                handle.write(result.data)
        for temporary, destination, size, family in staged:
            temporary.replace(destination)
            if destination.stat().st_size != size:
                raise SystemExit(f"{family} size changed while publishing")
    finally:
        for temporary, _destination, _size, _family in staged:
            temporary.unlink(missing_ok=True)


def print_table(results: tuple[SubsetResult, ...]) -> None:
    print(f"fontTools {fontTools.__version__}")
    print(f"brotli {brotli.__version__}")
    print(f"{'Face':<12} {'Before':>8} {'After':>8} {'Glyphs':>8} {'cmap':>8}")
    for result in results:
        print(
            f"{result.family:<12} {result.before:8d} {result.after:8d} {result.glyphs:8d} {result.cmap:8d}"
        )


def main() -> None:
    require_versions()
    site = Path(__file__).resolve().parents[1]
    scanned = scanned_codepoints(site)
    results = tuple(subset_face(face, site, scanned) for face in FACES)
    publish(site, results)
    print_table(results)


if __name__ == "__main__":
    main()
