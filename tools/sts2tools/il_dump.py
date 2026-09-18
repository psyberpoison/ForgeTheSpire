#!/usr/bin/env python3
"""Minimal CIL method-body disassembler on top of the project's own
ECMA-335 metadata reader (tools/sts2tools/ecma_dump_ext.py) — extended to
also load MemberRef/StandAloneSig/MethodSpec and the #US heap, and to
walk a MethodDef's RVA to decode its IL body well enough to see every
call/callvirt/newobj/ld-/st-field/ldstr target by name. No dependencies.

Usage: python3 il_dump.py <dll_path> <Namespace.TypeName> <MethodName> [<MethodName> ...]
       python3 il_dump.py <dll_path> --find <TypeNameFragment>   (list matching TypeDefs)
"""
import sys, struct, math

def u8(b,o): return b[o]
def u16(b,o): return struct.unpack_from('<H', b, o)[0]
def u32(b,o): return struct.unpack_from('<I', b, o)[0]
def i32(b,o): return struct.unpack_from('<i', b, o)[0]
def i8(b,o): return struct.unpack_from('<b', b, o)[0]

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
        if is_pe32plus:
            nrva_off = opt_off + 108
        else:
            nrva_off = opt_off + 92
        num_rva = u32(data, nrva_off)
        datadir_off = nrva_off + 4
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
    'CustomAttributeType': ['MethodDef','MemberRef'],
    'ResolutionScope': ['Module','ModuleRef','AssemblyRef','TypeRef'],
    'TypeOrMethodDef': ['TypeDef','MethodDef'],
}

ELEM_PRIM = {
    0x01:'void',0x02:'bool',0x03:'char',0x04:'sbyte',0x05:'byte',0x06:'short',
    0x07:'ushort',0x08:'int',0x09:'uint',0x0A:'long',0x0B:'ulong',0x0C:'float',
    0x0D:'double',0x0E:'string',0x16:'TypedReference',0x18:'IntPtr',0x19:'UIntPtr',
    0x1C:'object',
}

# ---- CIL opcode table (ECMA-335 Partition III) -----------------------
# operand kind: None, 'i1','u1','i2','u2','i4','u4','i8','r4','r8',
#               'tok'(4-byte metadata/string token), 'br1','br4','switch'
ONE_BYTE = {
    0x00:('nop',None), 0x01:('break',None),
    0x02:('ldarg.0',None), 0x03:('ldarg.1',None), 0x04:('ldarg.2',None), 0x05:('ldarg.3',None),
    0x06:('ldloc.0',None), 0x07:('ldloc.1',None), 0x08:('ldloc.2',None), 0x09:('ldloc.3',None),
    0x0A:('stloc.0',None), 0x0B:('stloc.1',None), 0x0C:('stloc.2',None), 0x0D:('stloc.3',None),
    0x0E:('ldarg.s','u1'), 0x0F:('ldarga.s','u1'), 0x10:('starg.s','u1'),
    0x11:('ldloc.s','u1'), 0x12:('ldloca.s','u1'), 0x13:('stloc.s','u1'),
    0x14:('ldnull',None),
    0x15:('ldc.i4.m1',None), 0x16:('ldc.i4.0',None), 0x17:('ldc.i4.1',None), 0x18:('ldc.i4.2',None),
    0x19:('ldc.i4.3',None), 0x1A:('ldc.i4.4',None), 0x1B:('ldc.i4.5',None), 0x1C:('ldc.i4.6',None),
    0x1D:('ldc.i4.7',None), 0x1E:('ldc.i4.8',None),
    0x1F:('ldc.i4.s','i1'), 0x20:('ldc.i4','i4'), 0x21:('ldc.i8','i8'),
    0x22:('ldc.r4','r4'), 0x23:('ldc.r8','r8'),
    0x25:('dup',None), 0x26:('pop',None),
    0x27:('jmp','tok'), 0x28:('call','tok'), 0x29:('calli','tok'), 0x2A:('ret',None),
    0x2B:('br.s','br1'), 0x2C:('brfalse.s','br1'), 0x2D:('brtrue.s','br1'),
    0x2E:('beq.s','br1'), 0x2F:('bge.s','br1'), 0x30:('bgt.s','br1'), 0x31:('ble.s','br1'),
    0x32:('blt.s','br1'), 0x33:('bne.un.s','br1'), 0x34:('bge.un.s','br1'), 0x35:('bgt.un.s','br1'),
    0x36:('ble.un.s','br1'), 0x37:('blt.un.s','br1'),
    0x38:('br','br4'), 0x39:('brfalse','br4'), 0x3A:('brtrue','br4'),
    0x3B:('beq','br4'), 0x3C:('bge','br4'), 0x3D:('bgt','br4'), 0x3E:('ble','br4'), 0x3F:('blt','br4'),
    0x40:('bne.un','br4'), 0x41:('bge.un','br4'), 0x42:('bgt.un','br4'), 0x43:('ble.un','br4'), 0x44:('blt.un','br4'),
    0x45:('switch','switch'),
    0x46:('ldind.i1',None), 0x47:('ldind.u1',None), 0x48:('ldind.i2',None), 0x49:('ldind.u2',None),
    0x4A:('ldind.i4',None), 0x4B:('ldind.u4',None), 0x4C:('ldind.i8',None), 0x4D:('ldind.i',None),
    0x4E:('ldind.r4',None), 0x4F:('ldind.r8',None), 0x50:('ldind.ref',None),
    0x51:('stind.ref',None), 0x52:('stind.i1',None), 0x53:('stind.i2',None), 0x54:('stind.i4',None),
    0x55:('stind.i8',None), 0x56:('stind.r4',None), 0x57:('stind.r8',None),
    0x58:('add',None), 0x59:('sub',None), 0x5A:('mul',None), 0x5B:('div',None), 0x5C:('div.un',None),
    0x5D:('rem',None), 0x5E:('rem.un',None), 0x5F:('and',None), 0x60:('or',None), 0x61:('xor',None),
    0x62:('shl',None), 0x63:('shr',None), 0x64:('shr.un',None), 0x65:('neg',None), 0x66:('not',None),
    0x67:('conv.i1',None), 0x68:('conv.i2',None), 0x69:('conv.i4',None), 0x6A:('conv.i8',None),
    0x6B:('conv.r4',None), 0x6C:('conv.r8',None), 0x6D:('conv.u4',None), 0x6E:('conv.u8',None),
    0x6F:('callvirt','tok'), 0x70:('cpobj','tok'), 0x71:('ldobj','tok'),
    0x72:('ldstr','tok'), 0x73:('newobj','tok'), 0x74:('castclass','tok'), 0x75:('isinst','tok'),
    0x76:('conv.r.un',None),
    0x79:('unbox','tok'), 0x7A:('throw',None),
    0x7B:('ldfld','tok'), 0x7C:('ldflda','tok'), 0x7D:('stfld','tok'),
    0x7E:('ldsfld','tok'), 0x7F:('ldsflda','tok'), 0x80:('stsfld','tok'), 0x81:('stobj','tok'),
    0x82:('conv.ovf.i1.un',None), 0x83:('conv.ovf.i2.un',None), 0x84:('conv.ovf.i4.un',None),
    0x85:('conv.ovf.i8.un',None), 0x86:('conv.ovf.u1.un',None), 0x87:('conv.ovf.u2.un',None),
    0x88:('conv.ovf.u4.un',None), 0x89:('conv.ovf.u8.un',None), 0x8A:('conv.ovf.i.un',None), 0x8B:('conv.ovf.u.un',None),
    0x8C:('box','tok'), 0x8D:('newarr','tok'), 0x8E:('ldlen',None), 0x8F:('ldelema','tok'),
    0x90:('ldelem.i1',None), 0x91:('ldelem.u1',None), 0x92:('ldelem.i2',None), 0x93:('ldelem.u2',None),
    0x94:('ldelem.i4',None), 0x95:('ldelem.u4',None), 0x96:('ldelem.i8',None), 0x97:('ldelem.i',None),
    0x98:('ldelem.r4',None), 0x99:('ldelem.r8',None), 0x9A:('ldelem.ref',None),
    0x9B:('stelem.i',None), 0x9C:('stelem.i1',None), 0x9D:('stelem.i2',None), 0x9E:('stelem.i4',None),
    0x9F:('stelem.i8',None), 0xA0:('stelem.r4',None), 0xA1:('stelem.r8',None), 0xA2:('stelem.ref',None),
    0xA3:('ldelem','tok'), 0xA4:('stelem','tok'), 0xA5:('unbox.any','tok'),
    0xB3:('conv.ovf.i1',None), 0xB4:('conv.ovf.u1',None), 0xB5:('conv.ovf.i2',None), 0xB6:('conv.ovf.u2',None),
    0xB7:('conv.ovf.i4',None), 0xB8:('conv.ovf.u4',None), 0xB9:('conv.ovf.i8',None), 0xBA:('conv.ovf.u8',None),
    0xC2:('refanyval','tok'), 0xC3:('ckfinite',None), 0xC6:('mkrefany','tok'),
    0xD0:('ldtoken','tok'), 0xD1:('conv.u2',None), 0xD2:('conv.u1',None), 0xD3:('conv.i',None),
    0xD4:('conv.ovf.i',None), 0xD5:('conv.ovf.u',None),
    0xD6:('add.ovf',None), 0xD7:('add.ovf.un',None), 0xD8:('mul.ovf',None), 0xD9:('mul.ovf.un',None),
    0xDA:('sub.ovf',None), 0xDB:('sub.ovf.un',None), 0xDC:('endfinally',None),
    0xDD:('leave','br4'), 0xDE:('leave.s','br1'), 0xDF:('stind.i',None), 0xE0:('conv.u',None),
}
TWO_BYTE = {
    0x00:('arglist',None), 0x01:('ceq',None), 0x02:('cgt',None), 0x03:('cgt.un',None),
    0x04:('clt',None), 0x05:('clt.un',None),
    0x06:('ldftn','tok'), 0x07:('ldvirtftn','tok'),
    0x09:('ldarg','u2'), 0x0A:('ldarga','u2'), 0x0B:('starg','u2'),
    0x0C:('ldloc','u2'), 0x0D:('ldloca','u2'), 0x0E:('stloc','u2'),
    0x0F:('localloc',None), 0x11:('endfilter',None),
    0x12:('unaligned.','u1'), 0x13:('volatile.',None), 0x14:('tail.',None),
    0x15:('initobj','tok'), 0x16:('constrained.','tok'),
    0x17:('cpblk',None), 0x18:('initblk',None), 0x19:('no.','u1'),
    0x1A:('rethrow',None), 0x1C:('sizeof','tok'), 0x1D:('refanytype',None), 0x1E:('readonly.',None),
}

class MetadataReader:
    def __init__(self, path):
        with open(path,'rb') as f:
            data = f.read()
        self.data = data
        self.pe = PE(data)
        pe = self.pe
        md_off = pe.rva2off(pe.cli_rva)
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

    def _heap_get_user_string(self, idx):
        if idx == 0: return ''
        off, size = self.streams['#US']
        p = off + idx
        length, p = read_compressed(self.data, p)
        if length <= 0: return ''
        raw = self.data[p:p+length-1]  # last byte is a terminal flag, not text
        try:
            return raw.decode('utf-16-le', errors='replace')
        except Exception:
            return repr(raw)

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

        WANT = ('TypeDef','MethodDef','Param','TypeRef','TypeSpec','Field','Constant',
                'MemberRef','StandAloneSig','MethodSpec','NestedClass','FieldRVA')
        self.tables = {}
        for tid, tname, cnt in present:
            cols = COLUMNS.get(tname)
            if cols is None:
                raise ValueError(f"no column layout for table {tname} ({tid:#x}) — extend COLUMNS")
            widths = [col_width(ctype) for _, ctype in cols]
            rowsize = sum(widths)
            want = tname in WANT
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

    def typedef_or_ref_name(self, coded_val, tables=('TypeDef','TypeRef','TypeSpec')):
        tagbits = max(1, math.ceil(math.log2(len(tables))))
        tag = coded_val & ((1<<tagbits)-1)
        rid = coded_val >> tagbits
        tname = tables[tag]
        if tname in ('TypeDef','TypeRef'):
            row = self.tables[tname][rid-1]
            ns = self._heap_get_string(row['Namespace'])
            nm = self._heap_get_string(row['Name'])
            return f"{ns}.{nm}" if ns else nm
        if tname == 'TypeSpec':
            return f"TypeSpec#{rid}"
        if tname == 'ModuleRef':
            return f"ModuleRef#{rid}"
        if tname == 'MethodDef':
            row = self.tables['MethodDef'][rid-1]
            return self._heap_get_string(row['Name']) + "()"
        return f"{tname}#{rid}"

    def decode_type(self, blob, pos):
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
        elif et == 0x11 or et == 0x12:
            tok, pos = read_compressed(blob, pos)
            s = self.typedef_or_ref_name(tok)
        elif et == 0x13:
            n, pos = read_compressed(blob, pos)
            s = f"!{n}"
        elif et == 0x1E:
            n, pos = read_compressed(blob, pos)
            s = f"!!{n}"
        elif et == 0x1D:
            inner, pos = self.decode_type(blob, pos)
            s = f"{inner}[]"
        elif et == 0x0F:
            inner, pos = self.decode_type(blob, pos)
            s = f"{inner}*"
        elif et == 0x45:
            inner, pos = self.decode_type(blob, pos)
            s = inner
        elif et == 0x14:
            inner, pos = self.decode_type(blob, pos)
            rank, pos = read_compressed(blob, pos)
            numsizes, pos = read_compressed(blob, pos)
            for _ in range(numsizes):
                _, pos = read_compressed(blob, pos)
            numlo, pos = read_compressed(blob, pos)
            for _ in range(numlo):
                _, pos = read_compressed(blob, pos)
            s = f"{inner}[{','.join([''] * rank)}]"
        elif et == 0x15:
            base_et = blob[pos]; pos += 1
            tok, pos = read_compressed(blob, pos)
            base_name = self.typedef_or_ref_name(tok)
            argc, pos = read_compressed(blob, pos)
            args = []
            for _ in range(argc):
                a, pos = self.decode_type(blob, pos)
                args.append(a)
            s = f"{base_name}<{', '.join(args)}>"
        elif et == 0x1B:
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
            if pos < len(blob) and blob[pos] == 0x41:
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
                return i
        return None

    def find_typedef_by_simple_name(self, nm):
        out = []
        for i, row in enumerate(self.tables['TypeDef']):
            rname = self._heap_get_string(row['Name'])
            if rname == nm:
                rns = self._heap_get_string(row['Namespace'])
                out.append((i, f"{rns}.{rname}" if rns else rname))
        return out

    ACCESS = {0:'compilercontrolled',1:'private',2:'famandassem',3:'assembly',4:'family',5:'famorassem',6:'public'}

    def method_row_range(self, typedef_idx):
        typedefs = self.tables['TypeDef']
        start = typedefs[typedef_idx]['MethodList']
        end = typedefs[typedef_idx+1]['MethodList'] if typedef_idx+1 < len(typedefs) else len(self.tables['MethodDef'])+1
        return start, end

    def find_method(self, typedef_idx, method_name):
        start, end = self.method_row_range(typedef_idx)
        methoddefs = self.tables['MethodDef']
        matches = []
        for rid in range(start, end):
            row = methoddefs[rid-1]
            if self._heap_get_string(row['Name']) == method_name:
                matches.append(rid)
        return matches

    def memberref_name(self, rid):
        row = self.tables['MemberRef'][rid-1]
        cls = self.typedef_or_ref_name(row['Class'], CODED_INDEX_TABLES['MemberRefParent'])
        nm = self._heap_get_string(row['Name'])
        return f"{cls}::{nm}"

    def methoddef_name(self, rid):
        row = self.tables['MethodDef'][rid-1]
        nm = self._heap_get_string(row['Name'])
        typedefs = self.tables['TypeDef']
        owner = '?'
        for i in range(len(typedefs)):
            s, e = self.method_row_range(i)
            if s <= rid < e:
                ns = self._heap_get_string(typedefs[i]['Namespace'])
                tn = self._heap_get_string(typedefs[i]['Name'])
                owner = f"{ns}.{tn}" if ns else tn
                break
        return f"{owner}::{nm}"

    def field_name(self, rid):
        row = self.tables['Field'][rid-1]
        return self._heap_get_string(row['Name'])

    def resolve_tok(self, token):
        table = (token >> 24) & 0xFF
        rid = token & 0x00FFFFFF
        if table == 0x06:
            return self.methoddef_name(rid)
        if table == 0x0A:
            return self.memberref_name(rid)
        if table == 0x04:
            return self.field_name(rid)
        if table == 0x01:
            row = self.tables['TypeRef'][rid-1]
            ns = self._heap_get_string(row['Namespace']); nm = self._heap_get_string(row['Name'])
            return f"{ns}.{nm}" if ns else nm
        if table == 0x02:
            row = self.tables['TypeDef'][rid-1]
            ns = self._heap_get_string(row['Namespace']); nm = self._heap_get_string(row['Name'])
            return f"{ns}.{nm}" if ns else nm
        if table == 0x1B:
            return f"TypeSpec#{rid}"
        if table == 0x2B:
            row = self.tables['MethodSpec'][rid-1]
            base = self.typedef_or_ref_name(row['Method'], CODED_INDEX_TABLES['MethodDefOrRef'])
            return f"{base}<generic>"
        if table == 0x11:
            return f"StandAloneSig#{rid}"
        if table == 0x70:
            return "<string-token-should-not-reach-resolve_tok>"
        return f"tok(table={table:#x},rid={rid})"

    def disassemble(self, rva, max_bytes=6000):
        data = self.data
        off = self.pe.rva2off(rva)
        first = data[off]
        fmt = first & 0x3
        code_off = None
        code_size = None
        if fmt == 0x2:
            code_size = (first >> 2) & 0x3F
            code_off = off + 1
            maxstack = 8
        elif fmt == 0x3:
            flags = u16(data, off)
            hdr_size_dwords = (flags >> 12) & 0xF
            maxstack = u16(data, off+2)
            code_size = u32(data, off+4)
            localsig = u32(data, off+8)
            code_off = off + hdr_size_dwords*4
        else:
            raise ValueError(f"unrecognized method header format byte {first:#x}")
        code = data[code_off:code_off+min(code_size, max_bytes)]
        out = []
        p = 0
        while p < len(code):
            ilpos = p
            b = code[p]; p += 1
            if b == 0xFE:
                b2 = code[p]; p += 1
                if b2 not in TWO_BYTE:
                    out.append((ilpos, f"??FE{b2:02X}", None))
                    break
                mnem, kind = TWO_BYTE[b2]
            else:
                if b not in ONE_BYTE:
                    out.append((ilpos, f"??{b:02X}", None))
                    break
                mnem, kind = ONE_BYTE[b]
            operand_str = ''
            if kind is None:
                pass
            elif kind == 'u1':
                v = code[p]; p += 1; operand_str = str(v)
            elif kind == 'i1':
                v = struct.unpack_from('<b', code, p)[0]; p += 1; operand_str = str(v)
            elif kind == 'u2':
                v = struct.unpack_from('<H', code, p)[0]; p += 2; operand_str = str(v)
            elif kind == 'i4':
                v = struct.unpack_from('<i', code, p)[0]; p += 4; operand_str = str(v)
            elif kind == 'u4':
                v = struct.unpack_from('<I', code, p)[0]; p += 4; operand_str = str(v)
            elif kind == 'i8':
                v = struct.unpack_from('<q', code, p)[0]; p += 8; operand_str = str(v)
            elif kind == 'r4':
                v = struct.unpack_from('<f', code, p)[0]; p += 4; operand_str = str(v)
            elif kind == 'r8':
                v = struct.unpack_from('<d', code, p)[0]; p += 8; operand_str = str(v)
            elif kind == 'br1':
                v = struct.unpack_from('<b', code, p)[0]; p += 1
                operand_str = f"-> IL_{p+v:04X}"
            elif kind == 'br4':
                v = struct.unpack_from('<i', code, p)[0]; p += 4
                operand_str = f"-> IL_{p+v:04X}"
            elif kind == 'switch':
                n = struct.unpack_from('<I', code, p)[0]; p += 4
                targets = []
                for _ in range(n):
                    v = struct.unpack_from('<i', code, p)[0]; p += 4
                    targets.append(v)
                base = p
                operand_str = "[" + ", ".join(f"IL_{base+t:04X}" for t in targets) + "]"
            elif kind == 'tok':
                tok = struct.unpack_from('<I', code, p)[0]; p += 4
                if mnem == 'ldstr' and ((tok >> 24) & 0xFF) == 0x70:
                    s = self._heap_get_user_string(tok & 0x00FFFFFF)
                    operand_str = repr(s)
                else:
                    try:
                        operand_str = self.resolve_tok(tok)
                    except Exception as e:
                        operand_str = f"tok({tok:#010x}, resolve error: {e})"
            out.append((ilpos, mnem, operand_str))
        return out

if __name__ == '__main__':
    path = sys.argv[1]
    reader = MetadataReader(path)
    if sys.argv[2] == '--find':
        frag = sys.argv[3]
        for i, row in enumerate(reader.tables['TypeDef']):
            nm = reader._heap_get_string(row['Name'])
            ns = reader._heap_get_string(row['Namespace'])
            full = f"{ns}.{nm}" if ns else nm
            if frag in full:
                print(full)
        sys.exit(0)
    type_name = sys.argv[2]
    method_names = sys.argv[3:]
    tidx = reader.find_typedef(type_name)
    if tidx is None:
        print(f"TYPE NOT FOUND: {type_name}")
        cands = reader.find_typedef_by_simple_name(type_name.rpartition('.')[2])
        if cands:
            print("did you mean:")
            for i, full in cands:
                print(f"  {full}")
        sys.exit(1)
    for mname in method_names:
        rids = reader.find_method(tidx, mname)
        if not rids:
            print(f"=== {type_name}::{mname}: METHOD NOT FOUND ===")
            continue
        for rid in rids:
            row = reader.tables['MethodDef'][rid-1]
            sig = reader.decode_method_sig(reader._heap_get_blob(row['Signature']))
            rva = row['RVA']
            print(f"=== {type_name}::{mname}  RVA={rva:#x}  ret={sig['ret']}  params={sig['params']} ===")
            if rva == 0:
                print("  (no RVA -- abstract/extern/interface method, no body)")
                continue
            try:
                instrs = reader.disassemble(rva)
            except Exception as e:
                print(f"  DISASSEMBLY ERROR: {e}")
                continue
            for ilpos, mnem, operand in instrs:
                if operand is None:
                    print(f"  IL_{ilpos:04X}: {mnem}")
                else:
                    print(f"  IL_{ilpos:04X}: {mnem}  {operand}")
            print()
