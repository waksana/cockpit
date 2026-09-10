"""Extract only a bounded release payload, with no paths outside its fresh root."""
import os
import sys
import tarfile
import zipfile
from pathlib import Path

archive, destination = map(Path, sys.argv[1:3])
limit = 2 * 1024 * 1024 * 1024
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    if len(entries) != 1 or entries[0].filename != "release.tar.gz" or entries[0].file_size > 400 * 1024 * 1024:
        raise ValueError("Unexpected artifact payload")
    payload = destination.parent / (destination.name + ".tar.gz")
    with bundle.open(entries[0]) as source, payload.open("xb") as target:
        while block := source.read(1024 * 1024):
            target.write(block)
try:
    with tarfile.open(payload) as package:
        members = package.getmembers()
        if len(members) > 150000 or sum(item.size for item in members) > limit:
            raise ValueError("Release expansion limit exceeded")
        names = set()
        for item in members:
            name = item.name.removeprefix("./")
            if name in ("", "."):
                continue
            if name in names or Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("Invalid or duplicate release path")
            names.add(name)
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise ValueError("Unsupported release entry")
            if item.mode & 0o6000:
                raise ValueError("Privileged release entry")
            if item.issym() or item.islnk():
                base = destination / Path(name).parent if item.issym() else destination
                target = Path(os.path.realpath(base / item.linkname))
                if Path(item.linkname).is_absolute() or not target.is_relative_to(destination.resolve()):
                    raise ValueError("Release link escapes")
        package.extractall(destination, members=members, filter="data")
finally:
    payload.unlink()
