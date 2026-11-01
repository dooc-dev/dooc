// Minimal zip writer (deflate, UTF-8 file names). Hand-rolled to avoid adding an external
// dependency.
// shortcut: no ZIP64 support = can't handle more than 4GB / 65535 entries; switch to a library if
// the docs root outgrows that.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
    /** Path inside the zip (`/`-separated). */
    name: string;
    data: Buffer;
}

// Fixed date (1980-01-01 00:00) = the same input yields the same zip (reproducible).
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export const zip = (entries: readonly ZipEntry[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const body = deflateRawSync(data);
        const crc = crc32(data);
        // The "version … name length" part shared by the local and central headers.
        const common = Buffer.alloc(26);
        common.writeUInt16LE(20, 0); // version needed
        common.writeUInt16LE(0x0800, 2); // flag: UTF-8 file names
        common.writeUInt16LE(8, 4); // method: deflate
        common.writeUInt16LE(0, 6); // time
        common.writeUInt16LE(DOS_DATE, 8);
        common.writeUInt32LE(crc, 10);
        common.writeUInt32LE(body.length, 14);
        common.writeUInt32LE(data.length, 18);
        common.writeUInt16LE(nameBuf.length, 22);
        common.writeUInt16LE(0, 24); // extra length
        const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), common, nameBuf]);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4); // version made by = Unix / 3.0 (unzip keeps UTF-8 names)
        common.copy(central, 6);
        // 32: comment length / 34: disk / 36: internal attr = 0; 38: external attr = Unix mode 0644
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, body);
        centrals.push(central, nameBuf);
        offset += local.length + body.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
};
