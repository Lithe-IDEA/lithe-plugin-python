// Minimal deterministic tar.gz and zip reader/writer helpers using only Node built-ins.
import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafeRelativeEntry(entryName) {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }
  const parts = normalized.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`Unsafe archive entry path segments: ${entryName}`);
  }
  return normalized;
}

/** Extracts a single named regular file from a .tar.gz buffer. */
export function extractFileFromTarGz(tarGzBuffer, expectedName) {
  const tar = gunzipSync(tarGzBuffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = (prefix ? `${prefix}/${rawName}` : rawName).replace(/^\.\//, "");
    const typeFlag = String.fromCharCode(header[156] || 48);
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) {
      throw new Error(`Truncated tar entry ${fullName}`);
    }
    if ((typeFlag === "0" || typeFlag === "\0") && (fullName === expectedName || posix.basename(fullName) === expectedName)) {
      return Buffer.from(tar.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Entry ${expectedName} not found in tar.gz archive`);
}

/** Reads all entries from a ZIP / wheel buffer using the End of Central Directory record. */
export function readZipEntries(zipBuffer) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: End of Central Directory not found");
  }
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset + centralDirSize > zipBuffer.length) {
    throw new Error("Invalid ZIP archive: Central Directory out of bounds");
  }

  const entries = [];
  let ptr = centralDirOffset;
  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (zipBuffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("Invalid ZIP Central Directory entry signature");
    }
    const compressionMethod = zipBuffer.readUInt16LE(ptr + 10);
    const expectedCrc = zipBuffer.readUInt32LE(ptr + 16);
    const compressedSize = zipBuffer.readUInt32LE(ptr + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(ptr + 24);
    const fileNameLen = zipBuffer.readUInt16LE(ptr + 28);
    const extraLen = zipBuffer.readUInt16LE(ptr + 30);
    const commentLen = zipBuffer.readUInt16LE(ptr + 32);
    const externalAttrs = zipBuffer.readUInt32LE(ptr + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42);
    const name = zipBuffer.subarray(ptr + 46, ptr + 46 + fileNameLen).toString("utf8");
    ptr += 46 + fileNameLen + extraLen + commentLen;

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0o170000) === 0o120000;
    const isDirectory = name.endsWith("/") || (unixMode & 0o170000) === 0o040000;

    if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${name}`);
    }
    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    let data = Buffer.alloc(0);
    if (!isDirectory) {
      if (compressionMethod === 0) {
        data = Buffer.from(rawSlice);
      } else if (compressionMethod === 8) {
        data = inflateRawSync(rawSlice);
      } else {
        throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
      }
      if (data.length !== uncompressedSize) {
        throw new Error(`ZIP size mismatch for ${name}: expected ${uncompressedSize}, got ${data.length}`);
      }
      if (crc32(data) !== expectedCrc) {
        throw new Error(`ZIP CRC-32 mismatch for ${name}`);
      }
    }

    entries.push({
      name,
      isDirectory,
      isSymlink,
      unixMode,
      data,
    });
  }
  return entries;
}

/** Extracts a single named binary from a ZIP buffer. */
export function extractFileFromZip(zipBuffer, expectedName) {
  for (const entry of readZipEntries(zipBuffer)) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink) {
      throw new Error(`Refusing symbolic link in archive: ${entry.name}`);
    }
    const clean = entry.name.replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean === expectedName || posix.basename(clean) === expectedName) {
      return entry.data;
    }
  }
  throw new Error(`Entry ${expectedName} not found in zip archive`);
}

/**
 * Extracts a Python package subtree (e.g. "debugpy/" or "tomli/") from a .whl buffer into destDir,
 * stripping bytecode, __pycache__, hidden dotfiles, and refusing symbolic links.
 */
export function extractWheelSubtree(wheelBuffer, packagePrefix, destParentDir) {
  let extractedCount = 0;
  for (const entry of readZipEntries(wheelBuffer)) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink) {
      throw new Error(`Refusing symbolic link in wheel: ${entry.name}`);
    }
    const normalized = assertSafeRelativeEntry(entry.name);
    if (!normalized.startsWith(`${packagePrefix}/`)) continue;
    const parts = normalized.split("/");
    if (parts.some((p) => p === "__pycache__" || p.startsWith("."))) continue;
    if (/\.(pyc|pyo)$/i.test(normalized)) continue;

    const targetPath = join(destParentDir, ...parts);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, entry.data);
    chmodSync(targetPath, 0o644);
    extractedCount += 1;
  }
  if (extractedCount === 0) {
    throw new Error(`No files extracted for prefix ${packagePrefix}/ from wheel`);
  }
  return extractedCount;
}

/** Writes a deterministic POSIX-compatible ZIP archive of `<stageRoot>/<rootDirName>`. */
export function writeDeterministicZip(stageRoot, rootDirName, outputZipPath) {
  const collected = [];

  function walk(absDir, relPosix) {
    const names = readdirSync(absDir).sort();
    for (const name of names) {
      if (name === ".DS_Store") continue;
      const absPath = join(absDir, name);
      const stat = lstatSync(absPath);
      const rel = `${relPosix}/${name}`;
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic link forbidden in plugin package: ${rel}`);
      }
      if (stat.isDirectory()) {
        walk(absPath, rel);
      } else if (stat.isFile()) {
        const executable = (stat.mode & 0o111) !== 0;
        collected.push({
          name: rel,
          data: readFileSync(absPath),
          unixMode: executable ? 0o100755 : 0o100644,
        });
      }
    }
  }

  walk(join(stageRoot, rootDirName), rootDirName);

  // Fixed DOS timestamp: 2026-01-01 00:00:00 for deterministic builds.
  const dosTime = 0x0000;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const item of collected) {
    const nameBuf = Buffer.from(item.name, "utf8");
    const uncompressed = item.data;
    const deflated = deflateRawSync(uncompressed, { level: 9 });
    const useDeflate = deflated.length < uncompressed.length;
    const body = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // UNIX (3) + version 2.0
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((item.unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    offset += localHeader.length + body.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(collected.length, 8);
  eocd.writeUInt16LE(collected.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  mkdirSync(dirname(outputZipPath), { recursive: true });
  writeFileSync(outputZipPath, Buffer.concat([...localChunks, centralDir, eocd]));
}
