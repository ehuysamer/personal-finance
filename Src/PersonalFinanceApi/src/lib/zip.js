import HttpError from "../models/httpError.model.js";


function zipError(message) {
  return new HttpError(422, "ERR-ZIP", message);
}

// Returns a Map of entry name -> { method, compressedSize, size, localOffset } from the central directory.
export function readZipEntries(buffer, invalid = zipError) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd === -1) throw invalid("file is not a zip archive");
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) throw invalid("zip directory is corrupt");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw invalid("ZIP64 archives are not supported");
    entries.set(name, { method, compressedSize, size, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The compressed bytes of an entry, located through its local header.
export function entryData(buffer, name, entry, invalid = zipError) {
  const { localOffset, compressedSize } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid(`zip entry ${name} is corrupt`);
  const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  return buffer.subarray(start, start + compressedSize);
}

// only its first line (the header) and the lines matching the filter are kept, so a large CSV never has to
// fit in memory. Lines are tested as latin1 text and written back byte for byte, so any encoding survives.
