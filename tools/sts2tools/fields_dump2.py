import sys
sys.path.insert(0, '.')
from ecma_dump_ext import MetadataReader, read_compressed

def fields_of(reader, full_name):
    idx = reader.find_typedef(full_name)
    if idx is None:
        return None
    typedefs = reader.tables['TypeDef']
    fields_table = reader.tables['Field']
    start = typedefs[idx]['FieldList']
    end = typedefs[idx+1]['FieldList'] if idx+1 < len(typedefs) else len(fields_table)+1

    # Build Constant lookup: Parent (coded HasConstant) -> (Type, Value blob)
    # HasConstant coded index: tables = ['Field','Param','Property'], 2 tag bits
    const_by_field_rid = {}
    if 'Constant' in reader.tables:
        for crow in reader.tables['Constant']:
            parent_coded = crow['Parent']
            tag = parent_coded & 0x3
            rid = parent_coded >> 2
            if tag == 0:  # Field
                const_by_field_rid[rid] = crow

    out = []
    for rid in range(start, end):
        row = fields_table[rid-1]
        name = reader._heap_get_string(row['Name'])
        flags = row['Flags']
        is_static = bool(flags & 0x10)
        is_literal = bool(flags & 0x40)
        access_bits = flags & 0x7
        access_map = {0:'compilercontrolled',1:'private',2:'famandassem',3:'assembly',4:'family',5:'famorassem',6:'public',7:'privateprotected'}
        vis = access_map.get(access_bits, '?')
        blob = reader._heap_get_blob(row['Signature'])
        pos = 0
        cc = blob[pos]; pos += 1
        ftype, pos = reader.decode_type(blob, pos)
        const_val = None
        if is_literal and rid in const_by_field_rid:
            crow = const_by_field_rid[rid]
            vblob = reader._heap_get_blob(crow['Value'])
            ctype = crow['Type']
            # common enum underlying: I4 (0x08) or I8, U1, etc.
            import struct as _s
            try:
                if ctype == 0x08 and len(vblob) >= 4:  # int32
                    const_val = _s.unpack_from('<i', vblob, 0)[0]
                elif ctype == 0x09 and len(vblob) >= 4:
                    const_val = _s.unpack_from('<I', vblob, 0)[0]
                elif ctype == 0x06 and len(vblob) >= 2:  # int16
                    const_val = _s.unpack_from('<h', vblob, 0)[0]
                elif ctype == 0x0A and len(vblob) >= 8:
                    const_val = _s.unpack_from('<q', vblob, 0)[0]
                elif ctype == 0x05 and len(vblob) >= 1:  # byte
                    const_val = vblob[0]
            except Exception:
                const_val = None
        out.append({'name': name, 'type': ftype, 'static': is_static, 'literal': is_literal, 'vis': vis, 'const': const_val})
    return out

if __name__ == '__main__':
    path = sys.argv[1]
    reader = MetadataReader(path)
    for full_name in sys.argv[2:]:
        fields = fields_of(reader, full_name)
        if fields is None:
            print(f"=== {full_name}: TYPE NOT FOUND ===")
            continue
        print(f"=== {full_name}: {len(fields)} fields ===")
        for f in fields:
            mods = []
            if f['static']: mods.append('static')
            if f['literal']: mods.append('literal')
            cval = f" = {f['const']}" if f['const'] is not None else ''
            print(f"  {f['vis']} {' '.join(mods)} {f['type']} {f['name']}{cval}")
