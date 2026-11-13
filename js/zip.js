// 아주 작은 zip 읽기 — 저장(0)·deflate(8)만. 큰 zip 도 통째로 메모리에 올리지 않게 Blob.slice 로 하나씩 꺼낸다.

const decUtf8 = new TextDecoder('utf-8', { fatal: true });
let decKr = null;
try { decKr = new TextDecoder('euc-kr'); } catch { decKr = null; }

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try { return decUtf8.decode(bytes); } catch { /* 윈도우 압축은 보통 CP949 */ }
  return decKr ? decKr.decode(bytes) : new TextDecoder('latin1').decode(bytes);
}

async function readAB(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// 돌려줌: [{name, size, getBlob()}]
export async function listZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await readAB(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 끝 표시를 못 찾음');
  const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
  let count = dv.getUint16(10, true);
  let cdSize = dv.getUint32(12, true);
  let cdOff = dv.getUint32(16, true);

  // ZIP64
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0) {
      const ldv = new DataView(tail.buffer, tail.byteOffset + loc);
      if (ldv.getUint32(0, true) === 0x07064b50) {
        const z64off = Number(ldv.getBigUint64(8, true));
        const z = await readAB(blob, z64off, z64off + 56);
        const zdv = new DataView(z.buffer);
        count = Number(zdv.getBigUint64(32, true));
        cdSize = Number(zdv.getBigUint64(40, true));
        cdOff = Number(zdv.getBigUint64(48, true));
      }
    }
  }

  const cd = await readAB(blob, cdOff, cdOff + cdSize);
  const cdv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) break;
    const flags = cdv.getUint16(p + 8, true);
    const method = cdv.getUint16(p + 10, true);
    let csize = cdv.getUint32(p + 20, true);
    let usize = cdv.getUint32(p + 24, true);
    const nlen = cdv.getUint16(p + 28, true);
    const xlen = cdv.getUint16(p + 30, true);
    const clen = cdv.getUint16(p + 32, true);
    let lho = cdv.getUint32(p + 42, true);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
    // ZIP64 추가 칸
    let xp = p + 46 + nlen;
    const xend = xp + xlen;
    while (xp + 4 <= xend) {
      const id = cdv.getUint16(xp, true), sz = cdv.getUint16(xp + 2, true);
      if (id === 1) {
        let q = xp + 4;
        if (usize === 0xffffffff) { usize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cdv.getBigUint64(q, true)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(cdv.getBigUint64(q, true)); q += 8; }
      }
      xp += 4 + sz;
    }
    p = xend + clen;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      size: usize,
      async getBlob() {
        const h = await readAB(blob, lho, lho + 30);
        const hdv = new DataView(h.buffer);
        if (hdv.getUint32(0, true) !== 0x04034b50) throw new Error('zip 항목 머리가 깨짐: ' + name);
        const start = lho + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
        const part = blob.slice(start, start + csize);
        if (method === 0) return part;
        if (method === 8) {
          const ds = part.stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return await new Response(ds).blob();
        }
        throw new Error('지원 안 하는 압축 방식(' + method + '): ' + name);
      },
    });
  }
  return entries;
}
