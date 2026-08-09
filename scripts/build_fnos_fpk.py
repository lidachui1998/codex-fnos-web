import gzip
import io
import os
import sys
import tarfile
import tempfile


stage = os.path.abspath(sys.argv[1])
output = os.path.abspath(sys.argv[2])


def normalized(value: str) -> str:
    return value.replace(os.sep, "/")


def is_executable(name: str) -> bool:
    return (
        name == "cmd"
        or name.startswith("cmd/")
        or (
            name.startswith("vendor/")
            and any(part in name for part in ("/bin/", "/codex-path/", "/codex-resources/"))
            and not name.endswith((".json", ".md", ".txt"))
        )
    )


def metadata(name: str, size: int = 0, directory: bool = False) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
    info.size = 0 if directory else size
    info.mode = 0o755 if directory or is_executable(name) else 0o644
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    return info


def add_path(archive: tarfile.TarFile, source: str, archive_name: str) -> None:
    if os.path.islink(source):
        raise RuntimeError(f"Refusing non-portable symbolic link: {source}")
    if os.path.isdir(source):
        archive.addfile(metadata(archive_name, directory=True))
        for item in sorted(os.listdir(source)):
            add_path(archive, os.path.join(source, item), f"{archive_name}/{item}")
        return
    size = os.path.getsize(source)
    with open(source, "rb") as source_file:
        archive.addfile(metadata(archive_name, size), source_file)


def open_deterministic_tgz(path: str):
    raw = open(path, "wb")
    zipped = gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0)
    archive = tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT)
    return raw, zipped, archive


if not os.path.isdir(os.path.join(stage, "app")):
    raise SystemExit(f"Missing app directory under stage: {stage}")

os.makedirs(os.path.dirname(output), exist_ok=True)
handle, app_archive_path = tempfile.mkstemp(suffix=".tgz", dir=os.path.dirname(output))
os.close(handle)
temporary_output = output + ".tmp"
try:
    raw, zipped, app_archive = open_deterministic_tgz(app_archive_path)
    try:
        for item in sorted(os.listdir(os.path.join(stage, "app"))):
            add_path(app_archive, os.path.join(stage, "app", item), item)
    finally:
        app_archive.close()
        zipped.close()
        raw.close()

    raw, zipped, package_archive = open_deterministic_tgz(temporary_output)
    try:
        app_size = os.path.getsize(app_archive_path)
        with open(app_archive_path, "rb") as app_file:
            package_archive.addfile(metadata("app.tgz", app_size), app_file)
        for item in sorted(os.listdir(stage)):
            if item == "app":
                continue
            add_path(package_archive, os.path.join(stage, item), item)
    finally:
        package_archive.close()
        zipped.close()
        raw.close()
    os.replace(temporary_output, output)
finally:
    for path in (app_archive_path, temporary_output):
        try:
            os.remove(path)
        except OSError:
            pass
