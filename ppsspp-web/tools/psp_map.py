#!/usr/bin/env python3
"""Builds a map of a PSP game: its module, imported system functions, code functions, strings and
disc files, from a *decrypted* executable (PPSSPP: Settings > Developer > Dump Decrypted EBOOT) and
optionally the disc image.

    python3 -I tools/psp_map.py <decrypted EBOOT.BIN> <ppsspp source dir> <out dir> [game.iso]

Writes into <out dir>: summary.md, imports.csv, functions.csv, strings.csv, classes.csv and (with an ISO)
files.csv. Everything it writes is derived from the game: keep it out of git and don't share it.
Needs: pip install capstone (and pycdlib for the ISO catalogue).
"""
import collections
import csv
import glob
import os
import re
import struct
import sys

import capstone


def load_nid_names(ppsspp_dir):
    """NID -> (module, function) from PPSSPP's HLE tables (Core/HLE/*.cpp)."""
    entry = re.compile(r'\{\s*(0[xX][0-9A-Fa-f]{8})\s*,\s*[^,{}]*?\s*,\s*"([A-Za-z_]\w*)"')
    table = re.compile(r'HLEFunction\s+(\w+)\s*\[\]\s*=\s*\{(.*?)\n\};', re.S)
    names = {}
    for path in glob.glob(os.path.join(ppsspp_dir, 'Core', '**', '*.cpp'), recursive=True):
        text = open(path, errors='replace').read()
        for t in table.finditer(text):
            for m in entry.finditer(t.group(2)):
                names.setdefault(int(m.group(1), 16), (t.group(1), m.group(2)))
    return names


class Image:
    """The executable's loadable segment, addressed by PSP virtual address."""

    def __init__(self, data):
        if data[:4] != b'\x7fELF':
            raise SystemExit('not an ELF file: is the EBOOT still encrypted (~PSP)? Dump it decrypted first.')
        self.data = data
        e_entry, e_phoff = struct.unpack_from('<II', data, 0x18)
        e_phentsize, e_phnum = struct.unpack_from('<HH', data, 0x2A)
        self.entry = e_entry
        self.segments = []
        for i in range(e_phnum):
            p_type, off, vaddr, paddr, filesz, memsz = struct.unpack_from('<6I', data, e_phoff + i * e_phentsize)
            if p_type == 1:
                self.segments.append((vaddr, off, filesz, memsz, paddr))
        if not self.segments:
            raise SystemExit('no loadable segment')

    def off(self, addr):
        for vaddr, off, filesz, _, _ in self.segments:
            if vaddr <= addr < vaddr + filesz:
                return off + addr - vaddr
        return None

    def u32(self, addr):
        o = self.off(addr)
        return None if o is None else struct.unpack_from('<I', self.data, o)[0]

    def u16(self, addr):
        o = self.off(addr)
        return None if o is None else struct.unpack_from('<H', self.data, o)[0]

    def cstr(self, addr, limit=64):
        o = self.off(addr)
        if o is None:
            return None
        end = self.data.find(b'\0', o, o + limit)
        return self.data[o:end if end >= 0 else o + limit].decode('latin-1')


def module_info(img):
    # For PSP executables the first segment's p_paddr is the file offset of SceModuleInfo.
    vaddr, off, _, _, paddr = img.segments[0]
    mi = vaddr + (paddr & 0x7FFFFFFF) - off
    name = img.cstr(mi + 4, 28)
    gp, ent_top, ent_end, stub_top, stub_end = (img.u32(mi + 32 + 4 * i) for i in range(5))
    return dict(addr=mi, name=name, attr=img.u16(mi), version=img.u16(mi + 2), gp=gp,
                ent=(ent_top, ent_end), stub=(stub_top, stub_end))


def imports(img, stub_top, stub_end, nid_names):
    out = []
    a = stub_top
    while a < stub_end:
        lib = img.cstr(img.u32(a)) or '?'
        size = img.data[img.off(a + 8)]
        count = img.u16(a + 10)
        nids, stubs = img.u32(a + 12), img.u32(a + 16)
        for i in range(count):
            nid = img.u32(nids + 4 * i)
            mod, fn = nid_names.get(nid, (None, None))
            out.append(dict(library=lib, nid=f'0x{nid:08X}', name=fn or '', stub=f'0x{stubs + 8 * i:08X}',
                            known_to_ppsspp='yes' if fn else 'no'))
        a += max(size, 5) * 4
    return out


def functions(img, stub_addrs):
    vaddr, off, filesz, _, _ = img.segments[0]
    code = img.data[off:off + filesz]
    md = capstone.Cs(capstone.CS_ARCH_MIPS, capstone.CS_MODE_MIPS32 + capstone.CS_MODE_LITTLE_ENDIAN)
    calls = collections.Counter()
    callers = collections.defaultdict(set)
    undecoded = 0
    # Walk every aligned word; capstone stops at instructions it doesn't know (Allegrex VFPU), so
    # decode one instruction at a time.
    for i in range(0, len(code) - 3, 4):
        word = struct.unpack_from('<I', code, i)[0]
        op = word >> 26
        if op == 3:  # jal target
            target = (((vaddr + i) & 0xF0000000) | ((word & 0x03FFFFFF) << 2))
            if vaddr <= target < vaddr + filesz:
                calls[target] += 1
                callers[target].add(vaddr + i)
    starts = sorted(set(calls) | {img.entry})
    rows = []
    for n, s in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else vaddr + filesz
        kind = 'import stub' if s in stub_addrs else 'code'
        size = end - s
        # Count instructions capstone can't decode (mostly Allegrex VFPU vector math) as a hint.
        if kind == 'code' and size <= 0x4000:
            o = img.off(s)
            for j in range(0, size, 4):
                if not list(md.disasm(img.data[o + j:o + j + 4], s + j)):
                    undecoded += 1
        rows.append(dict(address=f'0x{s:08X}', size=size, called_from=len(callers[s]), calls=calls[s], kind=kind,
                         entry='yes' if s == img.entry else ''))
    return rows, undecoded


def strings(img, min_len=6):
    vaddr, off, filesz, _, _ = img.segments[0]
    data = img.data[off:off + filesz]
    out = []
    for m in re.finditer(rb'[\x20-\x7e]{%d,}' % min_len, data):
        out.append(dict(address=f'0x{vaddr + m.start():08X}', text=m.group().decode('ascii')))
    return out


def classes(strs):
    """C++ class names from RTTI type-name strings (e.g. N2tk3net6driverE...), demangled with c++filt."""
    import subprocess
    mangled = [r for r in strs if re.fullmatch(r'(N\d|\d)[\w]*E?|N[\w]+E', r['text']) and re.search(r'\d[A-Za-z_]', r['text'])]
    if not mangled:
        return []
    res = subprocess.run(['c++filt'], input='\n'.join('_ZTS' + r['text'] for r in mangled), capture_output=True, text=True)
    out = []
    for r, d in zip(mangled, res.stdout.splitlines()):
        if d.startswith('typeinfo name for '):
            out.append(dict(address=r['address'], cls=d[len('typeinfo name for '):]))
    return out


def disc_files(iso_path):
    import pycdlib
    iso = pycdlib.PyCdlib()
    iso.open(iso_path)
    rows = []
    for root, _, files in iso.walk(iso_path='/'):
        for f in files:
            path = (root.rstrip('/') + '/' + f).split(';')[0]
            rec = iso.get_record(iso_path=root.rstrip('/') + '/' + f)
            size = rec.get_data_length()
            ext = os.path.splitext(path)[1].upper()
            rows.append(dict(path=path, size=size, type=ext.lstrip('.') or '-'))
    iso.close()
    return rows


def write_csv(path, rows):
    if not rows:
        open(path, 'w').close()
        return
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    elf, ppsspp_dir, out_dir = sys.argv[1:4]
    iso = sys.argv[4] if len(sys.argv) > 4 else None
    os.makedirs(out_dir, exist_ok=True)
    img = Image(open(elf, 'rb').read())
    mi = module_info(img)
    nid_names = load_nid_names(ppsspp_dir)
    imp = imports(img, *mi['stub'], nid_names)
    stub_addrs = {int(r['stub'], 16) for r in imp}
    funcs, undecoded = functions(img, stub_addrs)
    strs = strings(img)
    cls = classes(strs)
    write_csv(os.path.join(out_dir, 'classes.csv'), cls)
    write_csv(os.path.join(out_dir, 'imports.csv'), imp)
    write_csv(os.path.join(out_dir, 'functions.csv'), funcs)
    write_csv(os.path.join(out_dir, 'strings.csv'), strs)
    files = disc_files(iso) if iso else []
    if files:
        write_csv(os.path.join(out_dir, 'files.csv'), files)

    libs = collections.Counter(r['library'] for r in imp)
    unknown = [r for r in imp if r['known_to_ppsspp'] == 'no']
    code = [f for f in funcs if f['kind'] == 'code']
    top = sorted(code, key=lambda f: -f['calls'])[:15]
    vaddr, _, filesz, memsz, _ = img.segments[0]
    lines = [
        f'# Map of {mi["name"]}', '',
        f'- Executable: `{os.path.basename(elf)}`, {len(img.data):,} bytes, entry point `0x{img.entry:08X}`',
        f'- Loaded at `0x{vaddr:08X}`: {filesz:,} bytes from the file, {memsz:,} bytes in memory (the rest is zeroed data)',
        f'- Module info at `0x{mi["addr"]:08X}`: name `{mi["name"]}`, version {mi["version"] >> 8}.{mi["version"] & 0xFF}, gp `0x{mi["gp"]:08X}`',
        f'- {len(code):,} functions found from call instructions (functions only reached indirectly, '
        f'through pointers or jump tables, are not counted)',
        f'- {undecoded:,} instructions the MIPS disassembler could not decode: Allegrex VFPU vector math, '
        f'which Ghidra with the ghidra-allegrex plugin decodes',
        f'- {len(imp)} imported system functions from {len(libs)} libraries; '
        f'{len(imp) - len(unknown)} have names in PPSSPP\'s tables',
        f'- {len(strs):,} text strings, including {len(cls)} C++ class names from RTTI (classes.csv)', '',
        '## Imported libraries', '', '| Library | Functions |', '|---|---|',
        *[f'| {k} | {v} |' for k, v in libs.most_common()], '',
        '## Most called functions', '', '| Address | Calls | Size (bytes) |', '|---|---|---|',
        *[f'| `{f["address"]}` | {f["calls"]} | {f["size"]} |' for f in top], '',
    ]
    namespaces = collections.Counter('::'.join(c['cls'].split('<')[0].split('::')[:-1]) or '(global)' for c in cls)
    lines += ['## C++ namespaces (from RTTI class names)', '', '| Namespace | Classes |', '|---|---|',
              *[f'| `{k}` | {v} |' for k, v in namespaces.most_common(20)], '']
    if unknown:
        lines += ['## Imports without a name in PPSSPP', '',
                  *[f'- {r["library"]} `{r["nid"]}`' for r in unknown], '']
    if files:
        by_type = collections.Counter()
        for r in files:
            by_type[r['type']] += r['size']
        lines += ['## Disc files by type', '', '| Type | Files | Size |', '|---|---|---|',
                  *[f'| {t} | {sum(1 for r in files if r["type"] == t)} | {s / 1048576:.1f} MB |'
                    for t, s in by_type.most_common()], '']
    open(os.path.join(out_dir, 'summary.md'), 'w').write('\n'.join(lines))
    print('\n'.join(lines[:12]))


if __name__ == '__main__':
    main()
