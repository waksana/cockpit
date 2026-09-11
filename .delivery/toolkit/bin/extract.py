import os
import sys
import tarfile
import zipfile

archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) != 1 or entries[0].filename != "runtime.tar.gz" or entries[0].file_size > 400 * 1024 * 1024:
        raise ValueError("Expected a single bounded runtime.tar.gz")
    tarpath = os.path.join(os.path.dirname(destination), "runtime.tar.gz")
    with source.open(entries[0]) as stream, open(tarpath, "xb") as output:
        while chunk := stream.read(1024 * 1024):
            output.write(chunk)
with tarfile.open(tarpath) as source:
    entries = source.getmembers()
    if len(entries) > 100000 or sum(entry.size for entry in entries) > 2 * 1024**3:
        raise ValueError("Expanded runtime exceeds limits")
    for entry in entries:
        if entry.name.startswith("/") or ".." in entry.name.split("/") or entry.mode & 0o6000:
            raise ValueError("Unsafe archive path or mode")
        if not (entry.isfile() or entry.isdir() or entry.issym()):
            raise ValueError("Unsupported archive type")
        if entry.issym():
            target = os.path.realpath(os.path.join(destination, os.path.dirname(entry.name), entry.linkname))
            if os.path.commonpath([destination, target]) != destination or entry.linkname.startswith("/"):
                raise ValueError("External archive link")
    source.extractall(destination, filter="data")
