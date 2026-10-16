#!/usr/bin/env python3
"""Independent structure referee for TIFF/DNG and GIF (V1.5-1; widened in the V1.5-1 fix round, review S1). Python standard
library only; shares no code with the TypeScript engine (written from the TIFF 6.0 / TIFF-EP / DNG 1.7 / GIF89a
specifications, not from src/engine). Same author as the engine, so it is independent code, not an independent mind (L27).

Usage: python3 -I scripts/referee/structure.py <file> [<file> ...]   ->  JSON {file: report} on stdout

TIFF report:
  dirs            every directory reached: the IFD chain, SubIFDs, Exif, GPS, Interop and any IFD-type (13) entry, wherever
                  they are, and every `next` link (review S1a), with role, name and tags;
  dataSha256      SHA-256 over the picture data (strips, tiles, old-style JPEG) of every picture directory, by directory name
                  (picture directories = the IFD0 chain and SubIFDs of picture directories, TIFF 6.0 + Tech Note 1);
  decodeSha256    SHA-256 over the decode tags of every picture directory (its own list below; every value but the picture
                  offsets), by directory name (review S1c: proves the DNG raw image still decodes the same);
  extraTags       tags of picture directories that are not decode tags (review S1b: "Remove everything" may only leave
                  Orientation, the ICC profile and DNG's camera-model tag);
  unreferencedNonZero / largestGap   bytes no structure points at (review S1d / M3);
  uniqueCameraModel, ascii (text values), errors (incl. duplicate tags, review S2).
GIF report: SHA-256 over header + screen descriptor + colour table + every frame; every extension block with its sub-block
lengths and a payload hash; comments; plain-text blocks; bytes after the trailer; errors (review S1e).
"""
import hashlib
import json
import struct
import sys

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}

# Decode tags, typed from the specifications' tag tables (TIFF 6.0 Part 1 + Part 2, TIFF/EP CFA tags, DNG 1.7 chapter 4).
TIFF6 = [
    254, 255, 256, 257, 258, 259, 262, 263, 264, 265, 266, 273, 277, 278, 279, 280, 281, 282, 283, 284, 290, 291, 292, 293,
    296, 301, 317, 318, 319, 320, 321, 322, 323, 324, 325, 332, 334, 336, 338, 339, 340, 341, 342, 347, 512, 513, 514, 515,
    517, 518, 529, 530, 531, 532,
]
TIFF_EP = [33421, 33422]
DNG = [
    50706, 50707, 50710, 50711, 50712, 50713, 50714, 50715, 50716, 50717, 50718, 50719, 50720, 50721, 50722, 50723, 50724,
    50725, 50726, 50727, 50728, 50729, 50730, 50731, 50732, 50733, 50734, 50737, 50738, 50739, 50778, 50779, 50780, 50829,
    50830, 50831, 50832, 50833, 50834, 50879, 50935, 50937, 50938, 50939, 50940, 50941, 50964, 50965, 50970, 50972, 50974,
    50975, 50981, 50982, 51008, 51009, 51022, 51041, 51089, 51090, 51091, 51107, 51108, 51109, 51110, 51111, 51112, 51125,
    51177, 51178, 51179, 51180, 51181, 52525, 52526, 52529, 52530, 52531, 52532, 52533, 52534, 52535, 52536, 52537, 52538,
    52543, 52544, 52547, 52550, 52551, 52553, 52554, 52555,
]
DECODE = set(TIFF6 + TIFF_EP + DNG)
OFFSETS = {273, 324, 513}
PAIRS = ((273, 279), (324, 325), (513, 514))
POINTER = {330: "image", 34665: "exif", 34853: "gps", 40965: "interop"}


def tiff_report(data):
    rep = {"format": "tiff", "dirs": [], "dataSha256": None, "decodeSha256": None, "extraTags": [], "ascii": [], "errors": [],
           "unreferencedNonZero": 0, "largestGap": 0, "uniqueCameraModel": []}
    if data[:2] == b"II":
        e = "<"
    elif data[:2] == b"MM":
        e = ">"
    else:
        rep["errors"].append("bad byte order")
        return rep
    (magic,) = struct.unpack(e + "H", data[2:4])
    if magic != 42:
        rep["errors"].append("magic %d" % magic)
        return rep
    covered = [(0, 8)]
    pic_hash = {}
    dec_hash = {}
    seen = set()
    todo = [(struct.unpack(e + "I", data[4:8])[0], "image", "IFD0")]
    while todo:
        off, role, name = todo.pop(0)
        if off in seen:
            continue
        seen.add(off)
        if len(seen) > 1024:
            rep["errors"].append("too many directories")
            break
        if off < 8 or off + 2 > len(data):
            rep["errors"].append("%s outside file" % name)
            continue
        (n,) = struct.unpack(e + "H", data[off:off + 2])
        if off + 2 + 12 * n + 4 > len(data):
            rep["errors"].append("%s truncated" % name)
            continue
        covered.append((off, 2 + 12 * n + 4))
        tags = {}
        entries = []
        for i in range(n):
            p = off + 2 + 12 * i
            tag, typ, cnt = struct.unpack(e + "HHI", data[p:p + 8])
            if typ not in TYPE_SIZE:
                rep["errors"].append("%s tag %d of unknown type %d" % (name, tag, typ))
                continue
            size = TYPE_SIZE[typ] * cnt
            if size <= 4:
                val = data[p + 8:p + 8 + size]
            else:
                (vo,) = struct.unpack(e + "I", data[p + 8:p + 12])
                val = data[vo:vo + size]
                covered.append((vo, size))
                if vo + size > len(data):
                    rep["errors"].append("%s tag %d value outside file" % (name, tag))
            entries.append({"tag": tag, "type": typ, "count": cnt})
            if tag in tags:
                rep["errors"].append("%s: duplicate tag %d" % (name, tag))
            tags[tag] = (typ, cnt, val)
            if typ == 2:
                rep["ascii"].append(val.split(b"\0")[0].decode("latin-1"))
            if tag == 50708 and role == "image":
                rep["uniqueCameraModel"].append(val.split(b"\0")[0].decode("latin-1"))
        rep["dirs"].append({"name": name, "role": role, "offset": off, "tags": entries})

        def ints(tag):
            if tag not in tags:
                return []
            typ, cnt, val = tags[tag]
            fmt = {3: "H", 4: "I", 13: "I", 1: "B"}.get(typ)
            if not fmt or len(val) < cnt * struct.calcsize(fmt):
                return []
            return list(struct.unpack(e + fmt * cnt, val[:cnt * struct.calcsize(fmt)]))

        for o_tag, l_tag in PAIRS:
            for o, ln in zip(ints(o_tag), ints(l_tag)):
                if ln:
                    covered.append((o, ln))
        if role == "image":
            h = hashlib.sha256()
            for o_tag, l_tag in PAIRS:
                for o, ln in zip(ints(o_tag), ints(l_tag)):
                    h.update(data[o:o + ln])
            pic_hash[name] = h.hexdigest()
            d = hashlib.sha256()
            for tag in sorted(tags):
                typ, cnt, val = tags[tag]
                if tag in DECODE and tag not in OFFSETS:
                    d.update(struct.pack(">HHI", tag, typ, cnt) + val)
                elif tag not in DECODE and tag != 330:
                    rep["extraTags"].append(tag)
            dec_hash[name] = d.hexdigest()
        for tag, (typ, cnt, val) in tags.items():
            child = POINTER.get(tag) or ("private" if typ == 13 else None)
            if not child or typ not in (4, 13):
                continue
            if child == "image" and role != "image":
                child = "private"  # SubIFDs are a tag of a picture directory (TIFF Tech Note 1)
            for k, sub in enumerate(ints(tag)):
                todo.append((sub, child, "%s.Sub%d" % (name, k) if child == "image" else "%s/%s%d" % (name, child, tag)))
        (nxt,) = struct.unpack(e + "I", data[off + 2 + 12 * n:off + 6 + 12 * n])
        if nxt:
            todo.append((nxt, role, name + "+"))
    rep["dataSha256"] = hashlib.sha256("".join(k + pic_hash[k] for k in sorted(pic_hash)).encode()).hexdigest()
    rep["decodeSha256"] = hashlib.sha256("".join(k + dec_hash[k] for k in sorted(dec_hash)).encode()).hexdigest()
    covered.sort()
    pos = 0
    for o, ln in covered + [(len(data), 0)]:
        if o > pos:
            gap = data[pos:min(o, len(data))]
            rep["largestGap"] = max(rep["largestGap"], len(gap))
            rep["unreferencedNonZero"] += sum(1 for x in gap if x)
        pos = max(pos, o + ln)
    return rep


def gif_report(data):
    rep = {"format": "gif", "pictureSha256": None, "blocks": [], "comments": [], "plainText": [], "afterTrailer": 0, "frames": 0, "errors": []}
    if data[:3] != b"GIF":
        rep["errors"].append("bad header")
        return rep
    h = hashlib.sha256()
    flags = data[10]
    pos = 13 + (3 * (2 ** ((flags & 7) + 1)) if flags & 0x80 else 0)
    h.update(data[:pos])

    def blocks(p):
        out = b""
        lens = []
        while True:
            if p >= len(data):
                raise ValueError("ends early")
            n = data[p]
            p += 1
            if n == 0:
                return p, out, lens
            lens.append(n)
            out += data[p:p + n]
            p += n

    try:
        while True:
            if pos >= len(data):
                raise ValueError("no trailer")
            k = data[pos]
            if k == 0x3B:
                rep["afterTrailer"] = len(data) - pos - 1
                break
            if k == 0x2C:
                start = pos
                packed = data[pos + 9]
                pos += 10
                if packed & 0x80:
                    pos += 3 * (2 ** ((packed & 7) + 1))
                pos, _, _ = blocks(pos + 1)
                h.update(data[start:pos])
                rep["frames"] += 1
            elif k == 0x21:
                label = data[pos + 1]
                if label == 0xFF:
                    n = data[pos + 2]
                    ident = data[pos + 3:pos + 3 + n].decode("latin-1")
                    pos, payload, lens = blocks(pos + 3 + n)
                    rep["blocks"].append({"label": label, "app": ident, "length": len(payload), "subBlocks": lens,
                                          "payloadSha256": hashlib.sha256(payload).hexdigest()})
                else:
                    pos, payload, lens = blocks(pos + 2)
                    rep["blocks"].append({"label": label, "length": len(payload), "subBlocks": lens})
                    if label == 0xFE:
                        rep["comments"].append(payload.decode("latin-1"))
                    if label == 0x01:
                        rep["plainText"].append(payload[12:].decode("latin-1"))
            else:
                raise ValueError("unknown block %d at %d" % (k, pos))
    except (ValueError, IndexError) as exc:
        rep["errors"].append(str(exc))
    rep["pictureSha256"] = h.hexdigest()
    return rep


def main(paths):
    out = {}
    for p in paths:
        with open(p, "rb") as fh:
            data = fh.read()
        if data[:4] in (b"II*\0", b"MM\0*"):
            out[p] = tiff_report(data)
        elif data[:3] == b"GIF":
            out[p] = gif_report(data)
        else:
            out[p] = {"format": "other", "errors": ["not TIFF or GIF"]}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
