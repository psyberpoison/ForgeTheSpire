#!/usr/bin/env python3
"""Minimal Godot .pck (PackedSourcePCK) reader/extractor, hand-rolled
against the real, current Godot engine source (core/io/file_access_pack.cpp,
PackedSourcePCK::try_open_pack, fetched and quoted verbatim via WebFetch,
round 50) -- no dependencies, no Godot install needed. Supports format
versions 2 and 3 (the versions actually seen in STS2's own SlayTheSpire2.pck
[v3] and a real installed mod's TheBurdenedNewCharacter.pck [v2]); v4 header
fields are parsed but an ENCRYPTED directory is not supported (raises).

Built and used in round 50 to extract two real, independently-working
reference rest_site .tscn scenes straight out of their own real .pck files
(vanilla Ironclad's own scenes/rest_site/characters/ironclad_rest_site.tscn,
and Tyler's own installed TheBurdenedNewCharacter mod's real
scenes/rest_site/theburdenednewcharacter_rest_site.tscn) -- the hard
evidence that closed "what exact node structure does the real Rest site
scene need" for good, cross-validated against BaseLib.dll's own IL (see
il_dump.py, same round). Worth keeping around any time a future round needs
to pull a real reference asset (a scene, a script, a texture, anything)
straight out of the base game's or a real mod's own .pck to check Forge's
own generated output against ground truth, same pattern as il_dump.py for
compiled C#.

Usage: python3 pck_dump.py list <pck_path> [substring-filter]
       python3 pck_dump.py extract <pck_path> <res://-style path in the pck> <out_path>
"""

import struct, sys, os

PACK_HEADER_MAGIC = 0x43504447  # 'GDPC'
PACK_DIR_ENCRYPTED = 1 << 0
PACK_REL_FILEBASE = 1 << 1
PACK_SPARSE_BUNDLE = 1 << 2
PACK_FILE_REMOVAL = 1 << 0

def read_pck_index(path):
    with open(path, 'rb') as f:
        magic = struct.unpack('<I', f.read(4))[0]
        if magic != PACK_HEADER_MAGIC:
            raise ValueError(f"not a pck (magic={magic:#x})")
        pck_start_pos = f.tell() - 4
        version, ver_major, ver_minor, ver_patch = struct.unpack('<IIII', f.read(16))
        pack_flags = struct.unpack('<I', f.read(4))[0]
        enc_directory = bool(pack_flags & PACK_DIR_ENCRYPTED)
        rel_filebase = bool(pack_flags & PACK_REL_FILEBASE)
        sparse_bundle = bool(pack_flags & PACK_SPARSE_BUNDLE)
        file_base = struct.unpack('<Q', f.read(8))[0]
        if version in (3,4) or (version==2 and rel_filebase):
            file_base += pck_start_pos
        if version in (3,4):
            dir_offset = struct.unpack('<Q', f.read(8))[0] + pck_start_pos
            if sparse_bundle and enc_directory and version == 4:
                f.read(32)  # salt
            f.seek(dir_offset)
        elif version == 2:
            f.read(16*4)
        else:
            raise ValueError(f"unsupported version {version}")
        if enc_directory:
            raise ValueError("encrypted directory not supported by this reader")
        file_count = struct.unpack('<I', f.read(4))[0]
        entries = []
        for i in range(file_count):
            sl = struct.unpack('<I', f.read(4))[0]
            raw = f.read(sl)
            path_str = raw.rstrip(b'\x00').decode('utf-8', errors='replace')
            ofs, size = struct.unpack('<QQ', f.read(16))
            md5 = f.read(16)
            flags = struct.unpack('<I', f.read(4))[0]
            if flags & PACK_FILE_REMOVAL:
                continue
            entries.append((path_str, file_base + ofs, size, flags))
        return dict(version=version, ver=(ver_major,ver_minor,ver_patch), file_base=file_base,
                    file_count=file_count, entries=entries)

def extract(pck_path, res_path, out_path):
    idx = read_pck_index(pck_path)
    for p, ofs, size, flags in idx['entries']:
        if p == res_path:
            with open(pck_path, 'rb') as f:
                f.seek(ofs)
                data = f.read(size)
            with open(out_path, 'wb') as out:
                out.write(data)
            print(f"extracted {p} ({size} bytes) -> {out_path}")
            return True
    print(f"NOT FOUND: {res_path}")
    print(f"pck version={idx['version']} ver={idx['ver']} file_count={idx['file_count']}")
    return False

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'list':
        idx = read_pck_index(sys.argv[2])
        pat = sys.argv[3] if len(sys.argv) > 3 else None
        print(f"version={idx['version']} ver={idx['ver']} file_count={idx['file_count']}")
        for p, ofs, size, flags in idx['entries']:
            if pat is None or pat in p:
                print(f"{size:>10}  {p}")
    elif cmd == 'extract':
        extract(sys.argv[2], sys.argv[3], sys.argv[4])
