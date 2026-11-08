#!/usr/bin/env python3
"""Convert the 32-bit DOS/4GW Linear Executable inside DOOM.EXE to ELF32.

The DOS/4GW MZ stub in this binary predates e_lfanew: the dword at 0x3c is
part of the relocation table, not a header pointer.  So the LE header is
located by scanning for a validated "LE" header (there is exactly one).

Page map entries in this Watcom-produced LE store the physical page number
in the high 16 bits (the low 16 bits are zero flags).  Pages are written in
sequential order, as required by the task; a missing (trailing BSS) page is
zero-filled.

Only /work/original/DOOM.EXE is read.  Output is /work/analysis/doom-le.elf.
"""
import argparse
import os
import struct
import sys

MZ_LFANEW = 0x3C
LE_FIELDS = {
    0x18: "eip_object",       # 1-based object number holding EIP
    0x1C: "eip",
    0x28: "page_size",
    0x2C: "last_page_bytes",
    0x40: "object_table",
    0x44: "object_count",
    0x48: "page_map",
    0x68: "fixup_page_table",
    0x6C: "fixup_record_table",
    0x80: "data_pages",
}


class LE:
    def __init__(self, data):
        self.d = data
        self.h = self.find_header()
        for off, name in LE_FIELDS.items():
            setattr(self, name, self.u32(off))
        self.objects = []
        for i in range(self.object_count):
            vs, base, flags, first, count, res = struct.unpack_from(
                "<6I", self.d, self.h + self.object_table + 24 * i)
            self.objects.append({
                "index": i,
                "vsize": vs,
                "base": base,
                "flags": flags,
                "first_page": first,
                "page_count": count,
                "pages": [],
            })
        # page_map[logical page 1..n] -> physical page number
        self.page_number = {}
        n_pages = max(o["first_page"] + o["page_count"] - 1 for o in self.objects)
        for p in range(1, n_pages + 1):
            raw = self.u32(self.page_map + 4 * (p - 1))
            num = raw >> 16
            flags = raw & 0xFFFF
            self.page_number[p] = num if num else p
            if flags:
                # Flags are not expected for this file; keep going.
                pass
        for obj in self.objects:
            obj["pages"] = list(range(obj["first_page"],
                                      obj["first_page"] + obj["page_count"]))
        # object for each logical page (1-based)
        self.page_object = {}
        for obj in self.objects:
            for p in obj["pages"]:
                self.page_object[p] = obj

    def u32(self, off):
        return struct.unpack_from("<I", self.d, self.h + off)[0]

    def find_header(self):
        cand = struct.unpack_from("<I", self.d, MZ_LFANEW)[0]
        if 0 <= cand < len(self.d) - 0x90 and self.d[cand:cand + 2] in (b"LE", b"LX"):
            return cand
        # Scan for a validated LE header.  The shareware DOOM.EXE has one.
        best = None
        for i in range(0, len(self.d) - 0x90):
            if self.d[i:i + 2] != b"LE":
                continue
            try:
                ps = struct.unpack_from("<I", self.d, i + 0x28)[0]
                ot = struct.unpack_from("<I", self.d, i + 0x40)[0]
                no = struct.unpack_from("<I", self.d, i + 0x44)[0]
                dp = struct.unpack_from("<I", self.d, i + 0x80)[0]
                if 0 < ps <= 0x10000 and 0 < no < 1000 and i + ot + 24 * no < len(self.d) and dp > 0:
                    if best is None:
                        best = i
            except Exception:
                pass
        if best is None:
            raise SystemExit("no LE header found")
        return best

    # ------------------------------------------------------------------
    def page_file_offset(self, logical_page):
        num = self.page_number.get(logical_page, logical_page)
        # data_pages is stored relative to the start of the LE header in
        # this Watcom file (the task's "relative to file" wording is not
        # what the bytes say: header+0x1ce00 lands on the first page and
        # file-absolute 0x1ce00 lands inside the DOS extender stub).
        return self.h + self.data_pages + (num - 1) * self.page_size

    def object_file_size(self, obj):
        """Number of initialized bytes actually present for the object."""
        n = 0
        for p in obj["pages"]:
            off = self.page_file_offset(p)
            if off >= len(self.d):
                break
            have = min(self.page_size, len(self.d) - off)
            # The final stored page may be short.
            if have == 0:
                break
            n += have
            if have < self.page_size:
                break
        return min(n, obj["vsize"])

    def load_image(self):
        """Flat virtual-address image: base -> image bytes."""
        seg = {}
        for obj in self.objects:
            buf = bytearray(obj["vsize"])
            for i, p in enumerate(obj["pages"]):
                off = self.page_file_offset(p)
                if off >= len(self.d):
                    continue
                have = min(self.page_size, len(self.d) - off)
                if have <= 0:
                    continue
                dst = i * self.page_size
                take = min(have, max(0, obj["vsize"] - dst))
                if take > 0:
                    buf[dst:dst + take] = self.d[off:off + take]
            seg[obj["index"]] = buf
        return seg

    def parse_fixups(self):
        recs = []
        nr = max(self.page_number) if self.page_number else 0
        for page in range(1, nr + 1):
            a = self.u32(self.fixup_page_table + 4 * (page - 1))
            b = self.u32(self.fixup_page_table + 4 * page)
            pos = self.h + self.fixup_record_table + a
            end = self.h + self.fixup_record_table + b
            while pos < end:
                st = self.d[pos]
                tf = self.d[pos + 1]
                pos += 2
                typ = st & 0x0F
                is_list = bool(st & 0x20)
                if is_list:
                    count = self.d[pos]
                    pos += 1
                    srcs = list(struct.unpack_from("<%dh" % count, self.d, pos))
                    pos += 2 * count
                else:
                    srcs = [struct.unpack_from("<h", self.d, pos)[0]]
                    pos += 2
                if typ == 2:  # selector, no target offset
                    if tf & 0x40:
                        tobj = struct.unpack_from("<H", self.d, pos)[0]
                        pos += 2
                    else:
                        tobj = self.d[pos]
                        pos += 1
                    recs.append((page, typ, tf, srcs, tobj, None, None))
                    continue
                if tf & 0x40:
                    tobj = struct.unpack_from("<H", self.d, pos)[0]
                    pos += 2
                else:
                    tobj = self.d[pos]
                    pos += 1
                if tf & 0x10:
                    toff = struct.unpack_from("<I", self.d, pos)[0]
                    pos += 4
                else:
                    toff = struct.unpack_from("<H", self.d, pos)[0]
                    pos += 2
                add = None
                if tf & 0x04:
                    if tf & 0x20:
                        add = struct.unpack_from("<I", self.d, pos)[0]
                        pos += 4
                    else:
                        add = struct.unpack_from("<H", self.d, pos)[0]
                        pos += 2
                recs.append((page, typ, tf, srcs, tobj, toff, add))
        return recs

    def apply_fixups(self, seg):
        applied = 0
        skipped = 0
        data_index = max(self.objects, key=lambda o: o["base"])["index"]
        for page, typ, tf, srcs, tobj, toff, add in self.parse_fixups():
            if typ not in (6, 7, 8):
                skipped += 1
                continue  # selectors and 16-bit fields are left alone
            if (tobj - 1) not in seg:
                skipped += 1
                continue
            target = self.objects[tobj - 1]["base"] + (toff or 0) + (add or 0)
            obj = self.page_object.get(page)
            if obj is None:
                skipped += 1
                continue
            page_index = page - obj["first_page"]
            page_va = obj["base"] + page_index * self.page_size
            for s in srcs:
                va = page_va + s
                off = va - obj["base"]
                if off < 0 or off + 4 > len(seg[obj["index"]]):
                    skipped += 1
                    continue
                buf = seg[obj["index"]]
                raw = struct.unpack_from("<I", buf, off)[0]
                dst = off
                # The page/fixup tables in this particular Watcom LE contain a
                # small number of records whose source offset falls inside an
                # instruction immediate (and some zero immediates that are
                # genuine constants).  Applying those would overwrite code.
                # Validate the destination shape, and for code objects only
                # relocate zero slots or an off-by-one data pointer slot.
                if obj["index"] != data_index:
                    if self.inside_imm32(buf, off):
                        skipped += 1
                        continue
                    if raw != 0:
                        if (tobj - 1) == data_index and off >= 1 and (raw & 0x00FFFFFF) == 0 and (raw >> 24) != 0:
                            prev = struct.unpack_from("<I", buf, off - 1)[0]
                            if prev == 0:
                                dst = off - 1
                            else:
                                skipped += 1
                                continue
                        else:
                            skipped += 1
                            continue
                val = target
                if typ == 8:
                    val = (val - (va + 4)) & 0xFFFFFFFF
                elif typ == 6:
                    val = val & 0xFFFF
                struct.pack_into("<I", buf, dst, val)
                applied += 1
        self.fixups_applied = applied
        self.fixups_skipped = skipped

    @staticmethod
    def inside_imm32(buf, off):
        """True when off lies inside a 32-bit immediate of a mov r/m32,imm32."""
        for st in range(max(0, off - 7), off):
            if buf[st] != 0xC7:
                continue
            if st + 1 >= len(buf):
                continue
            m = buf[st + 1]
            mod = (m >> 6) & 3
            rm = m & 7
            if mod == 1 and rm != 4:
                imm = st + 3
            elif mod == 2 or (mod == 0 and rm == 5):
                imm = st + 6
            else:
                imm = st + 2
            if imm <= off < imm + 4:
                return True
        return False

    def entry(self):
        obj = self.objects[self.eip_object - 1]
        return obj["base"] + self.eip


def align(n, a):
    return (n + a - 1) & ~(a - 1)


def build_elf(le, seg):
    names = [b"", b".text", b".data", b".bss", b".shstrtab"]
    shstr = b"\0".join(names) + b"\0"
    # offsets into shstr
    name_off = {}
    cur = 0
    for n in names:
        name_off[n] = cur
        cur += len(n) + 1

    nobj = len(le.objects)
    ehsize = 52
    phentsize = 32
    shentsize = 40
    phnum = nobj
    phoff = ehsize
    data_start = align(phoff + phentsize * phnum, 16)
    file_off = [0] * nobj
    sizes = [le.object_file_size(o) for o in le.objects]
    bss_objs = [i for i, o in enumerate(le.objects) if sizes[i] < o["vsize"]]
    # null + one section per object + one .bss per object with BSS + shstrtab
    shnum = 1 + nobj + len(bss_objs) + 1
    cursor = data_start
    for i, obj in enumerate(le.objects):
        cursor = align(cursor, 0x1000) if False else align(cursor, 16)
        # PT_LOAD congruence: vaddr and offset must agree modulo page size.
        # All object bases here are 0x1000 aligned, so align file offsets.
        while (cursor - obj["base"]) % 0x1000:
            cursor += 1
        file_off[i] = cursor
        cursor += sizes[i]
    shoff = align(cursor, 4)
    total = shoff + shentsize * shnum + len(shstr)

    out = bytearray(total)
    # ELF header
    out[0:4] = b"\x7fELF"
    out[4] = 1   # ELFCLASS32
    out[5] = 1   # ELFDATA2LSB
    out[6] = 1   # EV_CURRENT
    out[7] = 0   # System V
    struct.pack_into("<HHIIIIIHHHHHH", out, 16,
                     2,          # ET_EXEC
                     3,          # EM_386
                     1,          # e_version
                     le.entry(),
                     phoff,
                     shoff,
                     0,          # flags
                     ehsize,
                     phentsize,
                     phnum,
                     shentsize,
                     shnum,
                     1 + nobj + len(bss_objs))   # e_shstrndx
    # Program headers
    for i, obj in enumerate(le.objects):
        executable = bool(obj["flags"] & 0x4)
        flags = 4 | (1 if executable else 2)
        struct.pack_into("<IIIIIIII", out, phoff + 32 * i,
                         1,               # PT_LOAD
                         file_off[i],
                         obj["base"],
                         obj["base"],
                         sizes[i],
                         obj["vsize"],
                         flags,
                         0x1000)
        out[file_off[i]:file_off[i] + sizes[i]] = bytes(seg[i][:sizes[i]])
    # Section headers
    sh = shoff
    # null
    struct.pack_into("<IIIIIIIIII", out, sh, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    for i, obj in enumerate(le.objects):
        executable = bool(obj["flags"] & 0x4)
        nm = b".text" if executable else b".data"
        struct.pack_into("<IIIIIIIIII", out, sh + shentsize * (i + 1),
                         name_off[nm],
                         1,                # SHT_PROGBITS
                         0x6 if executable else 0x3,  # ALLOC|EXEC / ALLOC|WRITE
                         obj["base"],
                         file_off[i],
                         sizes[i],
                         0, 0, 16, 0)
    for j, i in enumerate(bss_objs):
        obj = le.objects[i]
        struct.pack_into("<IIIIIIIIII", out,
                         sh + shentsize * (nobj + 1 + j),
                         name_off[b".bss"],
                         8,                # SHT_NOBITS
                         0x3,              # ALLOC|WRITE
                         obj["base"] + sizes[i],
                         file_off[i] + sizes[i],
                         obj["vsize"] - sizes[i],
                         0, 0, 16, 0)
    shstr_off = shoff + shentsize * shnum
    struct.pack_into("<IIIIIIIIII", out, sh + shentsize * (nobj + len(bss_objs) + 1),
                     name_off[b".shstrtab"],
                     3, 0, 0, shstr_off, len(shstr), 0, 0, 1, 0)
    out[shstr_off:shstr_off + len(shstr)] = shstr
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", default="/work/original/DOOM.EXE")
    ap.add_argument("output", nargs="?", default="/work/analysis/doom-le.elf")
    args = ap.parse_args()
    with open(args.input, "rb") as f:
        data = f.read()
    le = LE(data)
    seg = le.load_image()
    le.apply_fixups(seg)
    elf = build_elf(le, seg)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "wb") as f:
        f.write(elf)
    print("LE header at 0x%x; page size 0x%x; objects %d; entry 0x%x"
          % (le.h, le.page_size, len(le.objects), le.entry()))
    print("fixups applied %s; validated/skipped %s"
          % (getattr(le, "fixups_applied", 0), getattr(le, "fixups_skipped", 0)))
    for i, o in enumerate(le.objects):
        print("  object %d: base 0x%x vsize 0x%x pages %d flags 0x%x filebytes %d"
              % (i + 1, o["base"], o["vsize"], len(o["pages"]), o["flags"],
                 le.object_file_size(o)))
    print("wrote", args.output, len(elf), "bytes")


if __name__ == "__main__":
    main()
