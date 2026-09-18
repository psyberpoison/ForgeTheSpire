#!/usr/bin/env python3
"""Minimal ECMA-335 metadata reader — dumps all methods of a given TypeDef
(namespace + name) from a .NET assembly, with real parameter/return types
decoded straight from the method signature blobs. No dependencies.

Usage: python3 ecma_dump.py <dll_path> <Namespace.TypeName> [<Namespace.TypeName> ...]
"""
import sys, struct, math

def u8(b,o): return b[o]
def u16(b,o): return struct.unpack_from('<H', b, o)[0]
def u32(b,o): return struct.unpack_from('<I', b, o)[0]

def read_compressed(b, pos):
    first = b[pos]
    if first & 0x80 == 0:
        return first, pos+1
    if first & 0xC0 == 0x80:
        val = ((first & 0x3F) << 8) | b[pos+1]
        return val, pos+2
    if first & 0xE0 == 0xC0:
        val = ((first & 0x1F) << 24) | (b[pos+1] << 16) | (b[pos+2] << 8) | b[pos+3]
        return val, pos+4
    raise ValueError(f"bad compressed int at {pos}: {first:#x}")

class PE:
    def __init__(self, data):
        self.data = data
        e_lfanew = u32(data, 0x3C)
        assert data[e_lfanew:e_lfanew+4] == b'PE\x00\x00'
        coff = e_lfanew + 4
        num_sections = u16(data, coff+2)
        size_opt = u16(data, coff+16)
        opt_off = coff + 20
        magic = u16(data, opt_off)
        is_pe32plus = (magic == 0x20b)
        # NumberOfRvaAndSizes offset differs between PE32/PE32+
        if is_pe32plus:
            nrva_off = opt_off + 108
        else:
            nrva_off = opt_off + 92
        num_rva = u32(data, nrva_off)
        datadir_off = nrva_off + 4
        # data directory entry 14 = CLI header
        cli_dir_off = datadir_off + 14*8
        self.cli_rva = u32(data, cli_dir_off)
        self.cli_size = u32(data, cli_dir_off+4)
        sec_off = opt_off + size_opt
        self.sections = []
        for i in range(num_sections):
            so = sec_off + i*40
            vsize = u32(data, so+8)
            vaddr = u32(data, so+12)
            rawsize = u32(data, so+16)
            rawptr = u32(data, so+20)
            self.sections.append((vaddr, max(vsize, rawsize), rawptr))

    def rva2off(self, rva):
        for vaddr, size, rawptr in self.sections:
            if vaddr <= rva < vaddr+size:
                return rawptr + (rva - vaddr)
        raise ValueError(f"rva {rva:#x} not in any section")

TABLE_NAMES = {
    0x00:'Module',0x01:'TypeRef',0x02:'TypeDef',0x03:'FieldPtr',0x04:'Field',
    0x05:'MethodPtr',0x06:'MethodDef',0x07:'ParamPtr',0x08:'Param',0x09:'InterfaceImpl',
    0x0A:'MemberRef',0x0B:'Constant',0x0C:'CustomAttribute',0x0D:'FieldMarshal',
    0x0E:'DeclSecurity',0x0F:'ClassLayout',0x10:'FieldLayout',0x11:'StandAloneSig',
    0x12:'EventMap',0x13:'EventPtr',0x14:'Event',0x15:'PropertyMap',0x16:'PropertyPtr',
    0x17:'Property',0x18:'MethodSemantics',0x19:'MethodImpl',0x1A:'ModuleRef',
    0x1B:'TypeSpec',0x1C:'ImplMap',0x1D:'FieldRVA',0x1E:'ENCLog',0x1F:'ENCMap',
    0x20:'Assembly',0x21:'AssemblyProcessor',0x22:'AssemblyOS',0x23:'AssemblyRef',
    0x24:'AssemblyRefProcessor',0x25:'AssemblyRefOS',0x26:'File',0x27:'ExportedType',
    0x28:'ManifestResource',0x29:'NestedClass',0x2A:'GenericParam',0x2B:'MethodSpec',
    0x2C:'GenericParamConstraint',
}
NAME_TO_ID = {v:k for k,v in TABLE_NAMES.items()}

COLUMNS = {
    'Module': [('Generation','u2'),('Name','string'),('Mvid','guid'),('EncId','guid'),('EncBaseId','guid')],
    'TypeRef': [('ResolutionScope',('coded','ResolutionScope')),('Name','string'),('Namespace','string')],
    'TypeDef': [('Flags','u4'),('Name','string'),('Namespace','string'),('Extends',('coded','TypeDefOrRef')),('FieldList',('simple','Field')),('MethodList',('simple','MethodDef'))],
    'FieldPtr': [('Field',('simple','Field'))],
    'Field': [('Flags','u2'),('Name','string'),('Signature','blob')],
    'MethodPtr': [('Method',('simple','MethodDef'))],
    'MethodDef': [('RVA','u4'),('ImplFlags','u2'),('Flags','u2'),('Name','string'),('Signature','blob'),('ParamList',('simple','Param'))],
    'ParamPtr': [('Param',('simple','Param'))],
    'Param': [('Flags','u2'),('Sequence','u2'),('Name','string')],
    'InterfaceImpl': [('Class',('simple','TypeDef')),('Interface',('coded','TypeDefOrRef'))],
    'MemberRef': [('Class',('coded','MemberRefParent')),('Name','string'),('Signature','blob')],
    'Constant': [('Type','u2'),('Parent',('coded','HasConstant')),('Value','blob')],
    'CustomAttribute': [('Parent',('coded','HasCustomAttribute')),('Type',('coded','CustomAttributeType')),('Value','blob')],
    'FieldMarshal': [('Parent',('coded','HasFieldMarshal')),('NativeType','blob')],
    'DeclSecurity': [('Action','u2'),('Parent',('coded','HasDeclSecurity')),('PermissionSet','blob')],
    'ClassLayout': [('PackingSize','u2'),('ClassSize','u4'),('Parent',('simple','TypeDef'))],
    'FieldLayout': [('Offset','u4'),('Field',('simple','Field'))],
    'StandAloneSig': [('Signature','blob')],
    'EventMap': [('Parent',('simple','TypeDef')),('EventList',('simple','Event'))],
    'EventPtr': [('Event',('simple','Event'))],
    'Event': [('EventFlags','u2'),('Name','string'),('EventType',('coded','TypeDefOrRef'))],
    'PropertyMap': [('Parent',('simple','TypeDef')),('PropertyList',('simple','Property'))],
    'PropertyPtr': [('Property',('simple','Property'))],
    'Property': [('Flags','u2'),('Name','string'),('Type','blob')],
    'MethodSemantics': [('Semantics','u2'),('Method',('simple','MethodDef')),('Association',('coded','HasSemantics'))],
    'MethodImpl': [('Class',('simple','TypeDef')),('MethodBody',('coded','MethodDefOrRef')),('MethodDeclaration',('coded','MethodDefOrRef'))],
    'ModuleRef': [('Name','string')],
    'TypeSpec': [('Signature','blob')],
    'ImplMap': [('MappingFlags','u2'),('MemberForwarded',('coded','MemberForwarded')),('ImportName','string'),('ImportScope',('simple','ModuleRef'))],
    'FieldRVA': [('RVA','u4'),('Field',('simple','Field'))],
    'ENCLog': [('Token','u4'),('FuncCode','u4')],
    'ENCMap': [('Token','u4')],
    'Assembly': [('HashAlgId','u4'),('MajorVersion','u2'),('MinorVersion','u2'),('BuildNumber','u2'),('RevisionNumber','u2'),('Flags','u4'),('PublicKey','blob'),('Name','string'),('Culture','string')],
    'AssemblyProcessor': [('Processor','u4')],
    'AssemblyOS': [('OSPlatformID','u4'),('OSMajorVersion','u4'),('OSMinorVersion','u4')],
    'AssemblyRef': [('MajorVersion','u2'),('MinorVersion','u2'),('BuildNumber','u2'),('RevisionNumber','u2'),('Flags','u4'),('PublicKeyOrToken','blob'),('Name','string'),('Culture','string'),('HashValue','blob')],
    'AssemblyRefProcessor': [('Processor','u4'),('AssemblyRef',('simple','AssemblyRef'))],
    'AssemblyRefOS': [('OSPlatformID','u4'),('OSMajorVersion','u4'),('OSMinorVersion','u4'),('AssemblyRef',('simple','AssemblyRef'))],
    'File': [('Flags','u4'),('Name','string'),('HashValue','blob')],
    'ExportedType': [('Flags','u4'),('TypeDefId','u4'),('TypeName','string'),('TypeNamespace','string'),('Implementation',('coded','Implementation'))],
    'ManifestResource': [('Offset','u4'),('Flags','u4'),('Name','string'),('Implementation',('coded','Implementation'))],
    'NestedClass': [('NestedClass',('simple','TypeDef')),('EnclosingClass',('simple','TypeDef'))],
    'GenericParam': [('Number','u2'),('Flags','u2'),('Owner',('coded','TypeOrMethodDef')),('Name','string')],
    'MethodSpec': [('Method',('coded','MethodDefOrRef')),('Instantiation','blob')],
    'GenericParamConstraint': [('Owner',('simple','GenericParam')),('Constraint',('coded','TypeDefOrRef'))],
}

CODED_INDEX_TABLES = {
    'TypeDefOrRef': ['TypeDef','TypeRef','TypeSpec'],
    'HasConstant': ['Field','Param','Property'],
    'HasCustomAttribute': ['MethodDef','Field','TypeRef','TypeDef','Param','InterfaceImpl','MemberRef','Module','DeclSecurity','Property','Event','StandAloneSig','ModuleRef','TypeSpec','Assembly','AssemblyRef','File','ExportedType','ManifestResource','GenericParam','GenericParamConstraint','MethodSpec'],
    'HasFieldMarshal': ['Field','Param'],
    'HasDeclSecurity': ['TypeDef','MethodDef','Assembly'],
    'MemberRefParent': ['TypeDef','TypeRef','ModuleRef','MethodDef','TypeSpec'],
    'HasSemantics': ['Event','Property'],
    'MethodDefOrRef': ['MethodDef','MemberRef'],
    'MemberForwarded': ['Field','MethodDef'],
    'Implementation': ['File','AssemblyRef','ExportedType'],
    'CustomAttributeType': ['MethodDef','MemberRef'],  # simplified: only valid tags 2/3 used
    'ResolutionScope': ['Module','ModuleRef','AssemblyRef','TypeRef'],
    'TypeOrMethodDef': ['TypeDef','MethodDef'],
}

ELEM_PRIM = {
    0x01:'void',0x02:'bool',0x03:'char',0x04:'sbyte',0x05:'byte',0x06:'short',
    0x07:'ushort',0x08:'int',0x09:'uint',0x0A:'long',0x0B:'ulong',0x0C:'float',
    0x0D:'double',0x0E:'string',0x16:'TypedReference',0x18:'IntPtr',0x19:'UIntPtr',
    0x1C:'object',
}

class MetadataReader:
    def __init__(self, path):
        with open(path,'rb') as f:
            data = f.read()
        self.data = data
        pe = PE(data)
        md_off = pe.rva2off(pe.cli_rva)
        # IMAGE_COR20_HEADER: cb(4) MajorRV(2) MinorRV(2) MetaData RVA(4) Size(4) ...
        meta_rva = u32(data, md_off+8)
        meta_size = u32(data, md_off+12)
        self.meta_off = pe.rva2off(meta_rva)
        self._parse_metadata_root()
        self._parse_tables_stream()

    def _parse_metadata_root(self):
        data = self.data
        o = self.meta_off
        assert u32(data,o) == 0x424A5342, "not a valid metadata root (BSJB)"
        length = u32(data, o+12)
        vstr_off = o+16
        o2 = vstr_off + length
        # Flags(2), Streams(2)
        num_streams = u16(data, o2+2)
        o3 = o2+4
        self.streams = {}
        for i in range(num_streams):
            s_off = u32(data, o3)
            s_size = u32(data, o3+4)
            name_start = o3+8
            end = name_start
            while data[end] != 0: end += 1
            name = data[name_start:end].decode('ascii')
            padded_len = ((end - name_start) + 1 + 3) & ~3
            o3 = name_start + padded_len
            self.streams[name] = (self.meta_off + s_off, s_size)

    def _heap_get_string(self, idx):
        if idx == 0: return ''
        off, size = self.streams['#Strings']
        p = off + idx
        end = p
        while self.data[end] != 0: end += 1
        return self.data[p:end].decode('utf-8', errors='replace')

    def _heap_get_blob(self, idx):
        if idx == 0: return b''
        off, size = self.streams['#Blob']
        p = off + idx
        length, p = read_compressed(self.data, p)
        return self.data[p:p+length]

    def _parse_tables_stream(self):
        name = '#~' if '#~' in self.streams else '#-'
        off, size = self.streams[name]
        data = self.data
        heap_sizes = data[off+6]
        self.string_idx_size = 4 if (heap_sizes & 0x1) else 2
        self.guid_idx_size = 4 if (heap_sizes & 0x2) else 2
        self.blob_idx_size = 4 if (heap_sizes & 0x4) else 2
        valid = struct.unpack_from('<Q', data, off+8)[0]
        p = off + 24
        self.rowcounts = {}
        present = []
        for i in range(64):
            if valid & (1 << i):
                tname = TABLE_NAMES.get(i)
                cnt = u32(data, p); p += 4
                if tname:
                    self.rowcounts[tname] = cnt
                present.append((i, tname, cnt))

        def col_width(coltype):
            if coltype == 'u2': return 2
            if coltype == 'u4': return 4
            if coltype == 'string': return self.string_idx_size
            if coltype == 'guid': return self.guid_idx_size
            if coltype == 'blob': return self.blob_idx_size
            kind, ref = coltype
            if kind == 'simple':
                return 4 if self.rowcounts.get(ref,0) > 0xFFFF else 2
            if kind == 'coded':
                tables = CODED_INDEX_TABLES[ref]
                tagbits = max(1, math.ceil(math.log2(len(tables))))
                maxrows = max((self.rowcounts.get(t,0) for t in tables), default=0)
                limit = 1 << (16 - tagbits)
                return 4 if maxrows >= limit else 2

        self.tables = {}  # name -> list of dict
        for tid, tname, cnt in present:
            cols = COLUMNS.get(tname)
            if cols is None:
                raise ValueError(f"no column layout for table {tname} ({tid:#x}) — extend COLUMNS")
            widths = [col_width(ctype) for _, ctype in cols]
            rowsize = sum(widths)
            want = tname in ('TypeDef','MethodDef','Param','TypeRef','TypeSpec','Field','Constant')
            rows = []
            for r in range(cnt):
                if want:
                    row = {}
                    cp = p
                    for (cname, ctype), w in zip(cols, widths):
                        val = int.from_bytes(data[cp:cp+w], 'little')
                        row[cname] = val
                        cp += w
                    rows.append(row)
                p += rowsize
            if want:
                self.tables[tname] = rows

    # --- token / signature decoding -----------------------------------
    def typedef_or_ref_name(self, coded_val):
        tag = coded_val & 0x3
        rid = coded_val >> 2
        if tag == 0:  # TypeDef
            row = self.tables['TypeDef'][rid-1]
            ns = self._heap_get_string(row['Namespace'])
            nm = self._heap_get_string(row['Name'])
        elif tag == 1:  # TypeRef
            row = self.tables['TypeRef'][rid-1]
            ns = self._heap_get_string(row['Namespace'])
            nm = self._heap_get_string(row['Name'])
        elif tag == 2:  # TypeSpec
            return f"TypeSpec#{rid}"
        else:
            return f"?tag3#{rid}"
        return f"{ns}.{nm}" if ns else nm

    def decode_type(self, blob, pos):
        # skip leading custom mods
        while blob[pos] in (0x1F, 0x20):
            pos += 1
            _, pos = read_compressed(blob, pos)
        byref = False
        if blob[pos] == 0x10:
            byref = True
            pos += 1
        et = blob[pos]; pos += 1
        if et in ELEM_PRIM:
            s = ELEM_PRIM[et]
        elif et == 0x11 or et == 0x12:  # VALUETYPE / CLASS
            tok, pos = read_compressed(blob, pos)
            s = self.typedef_or_ref_name(tok)
        elif et == 0x13:  # VAR
            n, pos = read_compressed(blob, pos)
            s = f"!{n}"
        elif et == 0x1E:  # MVAR
            n, pos = read_compressed(blob, pos)
            s = f"!!{n}"
        elif et == 0x1D:  # SZARRAY
            inner, pos = self.decode_type(blob, pos)
            s = f"{inner}[]"
        elif et == 0x0F:  # PTR
            inner, pos = self.decode_type(blob, pos)
            s = f"{inner}*"
        elif et == 0x45:  # PINNED
            inner, pos = self.decode_type(blob, pos)
            s = inner
        elif et == 0x14:  # ARRAY
            inner, pos = self.decode_type(blob, pos)
            rank, pos = read_compressed(blob, pos)
            numsizes, pos = read_compressed(blob, pos)
            for _ in range(numsizes):
                _, pos = read_compressed(blob, pos)
            numlo, pos = read_compressed(blob, pos)
            for _ in range(numlo):
                _, pos = read_compressed(blob, pos)  # signed, approx ok
            s = f"{inner}[{','.join([''] * rank)}]"
        elif et == 0x15:  # GENERICINST
            base_et = blob[pos]; pos += 1
            tok, pos = read_compressed(blob, pos)
            base_name = self.typedef_or_ref_name(tok)
            argc, pos = read_compressed(blob, pos)
            args = []
            for _ in range(argc):
                a, pos = self.decode_type(blob, pos)
                args.append(a)
            s = f"{base_name}<{', '.join(args)}>"
        elif et == 0x1B:  # FNPTR — rare, skip conservatively
            s = "delegate*"
        else:
            s = f"?et{et:#x}"
        if byref:
            s = f"ref {s}"
        return s, pos

    def decode_method_sig(self, blob):
        if not blob:
            return {'params': [], 'ret': 'void', 'generic': False}
        pos = 0
        flags = blob[pos]; pos += 1
        hasthis = bool(flags & 0x20)
        generic = bool(flags & 0x10)
        genparamcount = 0
        if generic:
            genparamcount, pos = read_compressed(blob, pos)
        paramcount, pos = read_compressed(blob, pos)
        ret, pos = self.decode_type(blob, pos)
        params = []
        for _ in range(paramcount):
            if pos < len(blob) and blob[pos] == 0x41:  # SENTINEL
                pos += 1
            pt, pos = self.decode_type(blob, pos)
            params.append(pt)
        return {'params': params, 'ret': ret, 'hasthis': hasthis, 'generic': generic}

    def find_typedef(self, full_name):
        ns, _, nm = full_name.rpartition('.')
        for i, row in enumerate(self.tables['TypeDef']):
            rname = self._heap_get_string(row['Name'])
            rns = self._heap_get_string(row['Namespace'])
            if rname == nm and rns == ns:
                return i  # 0-based index into TypeDef table
        return None

    ACCESS = {0:'compilercontrolled',1:'private',2:'famandassem',3:'assembly',4:'family',5:'famorassem',6:'public'}

    def methods_of(self, full_name):
        idx = self.find_typedef(full_name)
        if idx is None:
            return None
        typedefs = self.tables['TypeDef']
        start = typedefs[idx]['MethodList']
        end = typedefs[idx+1]['MethodList'] if idx+1 < len(typedefs) else len(self.tables['MethodDef'])+1
        methoddefs = self.tables['MethodDef']
        params_table = self.tables['Param']
        out = []
        for rid in range(start, end):
            row = methoddefs[rid-1]
            name = self._heap_get_string(row['Name'])
            sig = self.decode_method_sig(self._heap_get_blob(row['Signature']))
            flags = row['Flags']
            access = self.ACCESS.get(flags & 0x7, '?')
            is_virtual = bool(flags & 0x0040)
            is_abstract = bool(flags & 0x0400)
            is_static = bool(flags & 0x0010)
            is_specialname = bool(flags & 0x0800)  # property/event accessors etc
            # resolve param names via Param table (sequence 1..n; 0 = return)
            pstart = row['ParamList']
            pend = methoddefs[rid] ['ParamList'] if rid < len(methoddefs) else len(params_table)+1
            names_by_seq = {}
            for prid in range(pstart, pend):
                prow = params_table[prid-1]
                names_by_seq[prow['Sequence']] = self._heap_get_string(prow['Name'])
            param_strs = []
            for i, ptype in enumerate(sig['params']):
                pname = names_by_seq.get(i+1, f"arg{i+1}")
                param_strs.append(f"{ptype} {pname}")
            out.append({
                'name': name, 'access': access, 'virtual': is_virtual,
                'abstract': is_abstract, 'static': is_static, 'specialname': is_specialname,
                'ret': sig['ret'], 'params': param_strs,
            })
        return out

if __name__ == '__main__':
    path = sys.argv[1]
    reader = MetadataReader(path)
    for full_name in sys.argv[2:]:
        methods = reader.methods_of(full_name)
        if methods is None:
            print(f"=== {full_name}: TYPE NOT FOUND ===")
            continue
        print(f"=== {full_name}: {len(methods)} methods ===")
        for m in methods:
            mods = []
            if m['static']: mods.append('static')
            if m['abstract']: mods.append('abstract')
            elif m['virtual']: mods.append('virtual')
            modstr = ' '.join(mods)
            sn = ' [specialname]' if m['specialname'] else ''
            print(f"  {m['access']} {modstr} {m['ret']} {m['name']}({', '.join(m['params'])}){sn}")
