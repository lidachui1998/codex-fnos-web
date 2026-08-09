import hashlib
import io
import json
import os
import re
import sys
import tarfile


package_path = os.path.abspath(sys.argv[1])
required_outer = {
    "app.tgz",
    "manifest",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "ICON.PNG",
    "ICON_256.PNG",
    "config/privilege",
    "config/resource",
    "cmd/main",
}
required_app = {
    "server/server/index.mjs",
    "server/dist/index.html",
    "server/package.json",
    "vendor/CODEX_VERSION",
    "vendor/openai-codex/package.json",
    "vendor/openai-codex/README.md",
    "vendor/x86_64-unknown-linux-musl/bin/codex",
    "ui/config",
    "ui/images/icon_64.png",
    "ui/images/icon_256.png",
}
forbidden_parts = {
    ".env",
    ".git",
    ".playwright-cli",
    "auth.json",
    "access-token",
    "access-password.json",
    "master.key",
    "codex-fnos.sqlite",
    "data-dev",
    "data-dev-19091",
    "output",
    "vendor-win",
}

with open(package_path, "rb") as package_file:
    package_bytes = package_file.read()

with tarfile.open(fileobj=io.BytesIO(package_bytes), mode="r:gz") as package:
    outer_members = package.getmembers()
    outer_names = {member.name.rstrip("/") for member in outer_members}
    missing_outer = sorted(required_outer - outer_names)
    if missing_outer:
        raise SystemExit(f"Missing outer package files: {missing_outer}")

    manifest_file = package.extractfile("manifest")
    manifest = manifest_file.read().decode("utf-8") if manifest_file else ""
    checks = {
        "identity": r"(?m)^appname=com\.lidachui\.codexweb$",
        "node24": r"(?m)^install_dep_apps=nodejs_v24$",
        "port": r"(?m)^service_port=19090$",
    }
    for label, pattern in checks.items():
        if not re.search(pattern, manifest):
            raise SystemExit(f"Manifest {label} is invalid")
    version_match = re.search(r"(?m)^version=([^\r\n]+)$", manifest)
    if not version_match:
        raise SystemExit("Manifest version is missing")

    for json_name in ("config/privilege", "config/resource"):
        source = package.extractfile(json_name)
        json.loads(source.read().decode("utf-8") if source else "")

    for script_name in (name for name in outer_names if name.startswith("cmd/") and name != "cmd"):
        script_member = package.getmember(script_name)
        if not script_member.mode & 0o111:
            raise SystemExit(f"Lifecycle script is not executable: {script_name}")
        source = package.extractfile(script_member)
        script = source.read() if source else b""
        if b"\r\n" in script:
            raise SystemExit(f"Lifecycle script contains CRLF: {script_name}")

    app_file = package.extractfile("app.tgz")
    if app_file is None:
        raise SystemExit("app.tgz is unreadable")
    with tarfile.open(fileobj=io.BytesIO(app_file.read()), mode="r:gz") as app:
        app_members = app.getmembers()
        app_names = {member.name.rstrip("/") for member in app_members}
        missing_app = sorted(required_app - app_names)
        if missing_app:
            raise SystemExit(f"Missing nested app files: {missing_app}")

        forbidden = []
        for name in app_names | outer_names:
            lowered = name.lower()
            parts = set(lowered.split("/"))
            if parts & forbidden_parts or lowered.endswith((".exe", ".pdb", ".map")):
                forbidden.append(name)
        if forbidden:
            raise SystemExit(f"Forbidden build or sensitive files found: {sorted(forbidden)[:20]}")

        codex_member = app.getmember("vendor/x86_64-unknown-linux-musl/bin/codex")
        if not codex_member.mode & 0o111:
            raise SystemExit("Bundled Codex binary is not executable")
        codex_file = app.extractfile(codex_member)
        if codex_file is None or codex_file.read(4) != b"\x7fELF":
            raise SystemExit("Bundled Codex binary is not an ELF executable")

        server_source = app.extractfile("server/server/index.mjs")
        server_bytes = server_source.read() if server_source else b""
        if (
            b"Codex fnOS Web listening" not in server_bytes
            or b"ProxyAgent" not in server_bytes
            or b"access-password.json" not in server_bytes
            or b"HttpOnly" not in server_bytes
        ):
            raise SystemExit("Bundled server does not contain the expected app and proxy runtime")

        ui_source = app.extractfile("ui/config")
        ui_config = json.loads(ui_source.read().decode("utf-8") if ui_source else "")
        launch = ui_config[".url"]["com.lidachui.codexweb.Application"]
        if launch.get("type") != "iframe" or launch.get("port") != "19090" or launch.get("url") != "/":
            raise SystemExit("Desktop launch configuration is invalid")

    cmd_main_mode = package.getmember("cmd/main").mode

print(
    json.dumps(
        {
            "ok": True,
            "path": package_path,
            "version": version_match.group(1).strip(),
            "bytes": len(package_bytes),
            "sha256": hashlib.sha256(package_bytes).hexdigest().upper(),
            "outerFiles": len(outer_names),
            "appFiles": len(app_names),
            "cmdMainMode": oct(cmd_main_mode),
            "codexMode": oct(codex_member.mode),
        },
        ensure_ascii=False,
        indent=2,
    )
)
