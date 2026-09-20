// compress.c — DEFLATE (RFC 1951) with FIXED Huffman codes, both directions.
//
// WHAT IT DOES: one fixed-Huffman block (BTYPE=01) covering the whole input;
// greedy LZ77 matching over a 32 KiB window with a bounded hash chain (most
// recent first, 64 deep); literals and end-of-block per §3.2.6; raw stream
// (no zlib or gzip wrapper). The decompressor accepts stored (BTYPE=00) and
// fixed (BTYPE=01) blocks, in any number, until BFINAL.
//
// WHAT IT DOES NOT ATTEMPT, said plainly: no dynamic Huffman blocks — the
// decompressor REFUSES them by name (-2) rather than misreading; no stored-
// block fallback on the compress side (incompressible input emits slightly
// more bytes than itself — fixed codes cost up to ~9 bits per literal); no
// optimal parsing — the match search is greedy, most recent first, chain
// bounded at 64.
//
// DETERMINISM: fixed traversal order and fixed tables — the same input bytes
// produce the same output bytes on every run and every host, which is the
// property the digest pin is built on.
//
//   layout:  input at inBuf (<= 64 KiB); compressed stream at cmpBuf
//            (<= 128 KiB); decompressed output at decBuf (<= 128 KiB)
//   exports: layoutIn/layoutCmp/layoutDec; compress(inLen) -> stream length
//            or -1 (output cap); decompress(inLen, maxOut) -> output length
//            or -1 (output cap) / -2 (dynamic block unsupported) / -3
//            (corrupt stream)

typedef unsigned int u32;
typedef unsigned char u8;

#define IN_BUF    65536
#define CMP_BUF   131072
#define DEC_BUF   131072
#define WSIZE     32768
#define HSIZE     4096
#define MIN_MATCH 3
#define MAX_MATCH 258
#define CHAIN     64

static u8  inBuf[IN_BUF];
static u8  cmpBuf[CMP_BUF];
static u8  decBuf[DEC_BUF];
static u32 head[HSIZE];   /* most recent position per 3-byte hash */
static u32 prev[WSIZE];   /* previous position in that hash chain */

/* ── bit writer: LSB-first, except Huffman codes which go MSB-first ── */

static u32 wByte, wBit, cmpLen;

static void putBit(int b) {
  wByte |= (u32)(b & 1) << wBit;
  if (++wBit == 8) { cmpBuf[cmpLen++] = (u8)wByte; wByte = 0; wBit = 0; }
}
static void putBits(u32 v, int n) { for (int i = 0; i < n; i++) putBit((int)(v >> i) & 1); }
static void putCode(u32 code, int n) { for (int i = n - 1; i >= 0; i--) putBit((int)(code >> i) & 1); }

static void putStaticLiteral(u32 lit) {
  if (lit < 144) putCode(0x30 + lit, 8);
  else putCode(0x190 + (lit - 144), 9);
}
static void putStaticLengthSymbol(u32 sym) { /* 257..287 */
  if (sym <= 279) putCode(sym - 256, 7);
  else putCode(0xC0 + (sym - 280), 8);
}

static const u32 lenBase[29]  = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
static const u32 lenExtra[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
static const u32 distBase[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
static const u32 distExtra[30] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13};

static u32 lengthSymbol(u32 len, u32 *extra, u32 *extraN) {
  u32 i = 28;
  while (len < lenBase[i]) i--;
  *extra = len - lenBase[i]; *extraN = lenExtra[i];
  return 257 + i;
}
static u32 distSymbol(u32 dist, u32 *extra, u32 *extraN) {
  u32 i = 29;
  while (dist < distBase[i]) i--;
  *extra = dist - distBase[i]; *extraN = distExtra[i];
  return i;
}
static u32 hash3(u32 pos) {
  return ((inBuf[pos] << 10) ^ (inBuf[pos + 1] << 5) ^ inBuf[pos + 2]) & (HSIZE - 1);
}

/* ── compress: one fixed-Huffman block, greedy LZ77 ── */

static void registerPos(u32 pos, u32 limit) {
  while (pos < limit) {
    if (pos + MIN_MATCH <= limit) {
      u32 h = hash3(pos);
      prev[pos % WSIZE] = head[h];
      head[h] = pos;
    }
    pos++;
  }
}

__attribute__((export_name("layoutIn")))  int layoutIn(void)  { return (int)inBuf; }
__attribute__((export_name("layoutCmp"))) int layoutCmp(void) { return (int)cmpBuf; }
__attribute__((export_name("layoutDec"))) int layoutDec(void) { return (int)decBuf; }

__attribute__((export_name("compress")))
int compress(int inLen) {
  if (inLen < 0 || inLen > IN_BUF) return -1;
  cmpLen = 0; wByte = 0; wBit = 0;
  for (u32 i = 0; i < HSIZE; i++) head[i] = (u32)-1;
  for (u32 i = 0; i < WSIZE; i++) prev[i] = (u32)-1;

  putBits(1, 1);  /* BFINAL = 1 */
  putBits(1, 2);  /* BTYPE = 01: fixed Huffman */

  u32 pos = 0;
  while (pos < (u32)inLen) {
    u32 matchLen = 0, matchDist = 0;
    if (pos + MIN_MATCH <= (u32)inLen) {
      u32 h = hash3(pos);
      u32 cand = head[h];
      u32 chain = CHAIN;
      while (cand != (u32)-1 && chain--) {
        u32 dist = pos - cand;
        if (dist == 0 || dist > WSIZE) break;
        u32 len = 0;
        while (len < MAX_MATCH && pos + len < (u32)inLen && inBuf[cand + len] == inBuf[pos + len]) len++;
        if (len > matchLen) { matchLen = len; matchDist = dist; if (matchLen == MAX_MATCH) break; }
        cand = prev[cand % WSIZE];
      }
    }

    if (matchLen >= MIN_MATCH) {
      u32 eBits, eN, sym = lengthSymbol(matchLen, &eBits, &eN);
      putStaticLengthSymbol(sym);
      if (eN) putBits(eBits, (int)eN);
      u32 dBits, dN, dsym = distSymbol(matchDist, &dBits, &dN);
      putCode(dsym, 5);
      if (dN) putBits(dBits, (int)dN);
      registerPos(pos, pos + matchLen);
      pos += matchLen;
    } else {
      putStaticLiteral(inBuf[pos]);
      registerPos(pos, pos + 1);
      pos += 1;
    }
    if (cmpLen > CMP_BUF) return -1; /* output cap exceeded: refused, never truncated */
  }

  putStaticLengthSymbol(256); /* end of block */
  if (wBit) cmpBuf[cmpLen++] = (u8)wByte;
  if (cmpLen > CMP_BUF) return -1;
  return (int)cmpLen;
}

/* ── decompress: the reader. Stored and fixed blocks; dynamic refused. ── */

static u32 rPos, rBit, decLen, decCap;

static int getBit(void) {
  if (rPos >= cmpLen) return -1;
  int bit = (int)(cmpBuf[rPos] >> rBit) & 1;
  if (++rBit == 8) { rBit = 0; rPos++; }
  return bit;
}
static int getBits(int n, u32 *out) {
  u32 v = 0;
  for (int i = 0; i < n; i++) { int b = getBit(); if (b < 0) return -1; v |= (u32)b << i; }
  *out = v; return 0;
}
static int getCodeMSB(int n, u32 *out) {
  u32 v = 0;
  for (int i = 0; i < n; i++) { int b = getBit(); if (b < 0) return -1; v = (v << 1) | (u32)b; }
  *out = v; return 0;
}
static int putDecByte(u8 byte) {
  if (decLen >= decCap) return -1; /* output cap: refused, never truncated */
  decBuf[decLen++] = byte; return 0;
}

static int decodeStaticLiteralOrLength(u32 *sym) {
  u32 code = 0;
  for (int len = 7; len <= 9; len++) {
    int bit = getBit(); if (bit < 0) return -3;
    code = (code << 1) | (u32)bit;
    if (len == 7 && code <= 0x17) { *sym = 256 + code; return 0; }
    if (len == 8) {
      if (code >= 0x30 && code <= 0xBF) { *sym = code - 0x30; return 0; }
      if (code >= 0xC0 && code <= 0xC7) { *sym = 280 + (code - 0xC0); return 0; }
    }
  }
  if (code >= 0x190) { *sym = 144 + (code - 0x190); return 0; }
  return -3; /* not a fixed code this decoder accepts */
}

static int inflateFixedBlock(void) {
  for (;;) {
    u32 sym;
    int rc = decodeStaticLiteralOrLength(&sym);
    if (rc) return rc;
    if (sym < 256) { if (putDecByte((u8)sym)) return -1; continue; }
    if (sym == 256) return 0;
    if (sym > 285) return -3;
    u32 li = sym - 257;
    u32 eBits = 0; if (lenExtra[li]) { if (getBits((int)lenExtra[li], &eBits)) return -3; }
    u32 len = lenBase[li] + eBits;

    u32 dcode;
    if (getCodeMSB(5, &dcode)) return -3;
    if (dcode > 29) return -3;
    u32 eBits2 = 0; if (distExtra[dcode]) { if (getBits((int)distExtra[dcode], &eBits2)) return -3; }
    u32 dist = distBase[dcode] + eBits2;
    if (dist > decLen) return -3;

    for (u32 k = 0; k < len; k++) {
      if (putDecByte(decBuf[decLen - dist])) return -1;
    }
  }
}

static int inflateStoredBlock(void) {
  if (rBit) { rBit = 0; rPos++; } /* discard to the byte boundary */
  if (rPos + 4 > cmpLen) return -3;
  u32 len = cmpBuf[rPos] | ((u32)cmpBuf[rPos + 1] << 8);
  u32 nlen = cmpBuf[rPos + 2] | ((u32)cmpBuf[rPos + 3] << 8);
  rPos += 4;
  if (len != ((~nlen) & 0xFFFF)) return -3;
  for (u32 i = 0; i < len; i++) {
    if (rPos >= cmpLen) return -3;
    if (putDecByte(cmpBuf[rPos++])) return -1;
  }
  return 0;
}

__attribute__((export_name("decompress")))
int decompress(int inLen, int maxOut) {
  if (inLen < 0 || inLen > CMP_BUF || maxOut < 0 || maxOut > DEC_BUF) return -1;
  cmpLen = (u32)inLen; rPos = 0; rBit = 0; decLen = 0; decCap = (u32)maxOut;
  for (;;) {
    int finalBit = getBit(); if (finalBit < 0) return -3;
    u32 typeBits;
    if (getBits(2, &typeBits)) return -3;
    if (typeBits == 2) return -2; /* dynamic Huffman: unsupported, by name */
    if (typeBits == 3) return -3; /* invalid */
    int rc = typeBits == 0 ? inflateStoredBlock() : inflateFixedBlock();
    if (rc) return rc;
    if (finalBit) break;
  }
  return (int)decLen;
}
