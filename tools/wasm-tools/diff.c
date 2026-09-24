// diff.c — a real line-level diff for the isocan wasm tool shelf.
//
// Hirschberg's linear-space LCS divide-and-conquer, over LINES of two input
// texts. No imports, no clock, no randomness: same bytes in, same script out,
// on any host. The host writes both texts into linear memory and reads an
// edit script of blocks back:
//
//   layout:  text A at 131072 (<= 64 KiB), text B at 196608, script at 262144
//   exports: layoutA() / layoutB() / layoutOut() — the host never hardcodes
//            an address; diff(aLen, bLen) -> script length in bytes, or < 0
//   script:  zero or more blocks { op u8; aLine u32; aCount u32; bLine u32;
//            bCount u32 } with op 0 = equal, 1 = delete (lines of A),
//            2 = insert (lines of B); terminated by op = 255. In order.
//
// Bounds: 4096 lines per side, 64 KiB per text, script region 256 KiB.
// The I/O layout starts ABOVE every static array, so nothing collides.

typedef unsigned int u32;
typedef unsigned char u8;

#define MAX_LINES 4096
#define MAX_TEXT  65536

/* The linker places these; initial memory always covers them, so the host
   never grows memory or guesses an offset. layoutA/B/Out hand the addresses. */
static u8 aText[MAX_TEXT];
static u8 bText[MAX_TEXT];
static u8 outRegion[262144];

static u32 aOff[MAX_LINES + 1], aLen[MAX_LINES];
static u32 bOff[MAX_LINES + 1], bLen[MAX_LINES];
static u32 na, nb;

static u32 fwdRow[MAX_LINES + 1];
static u32 revRow[MAX_LINES + 1];

static u8 *A = aText;
static u8 *B = bText;

static u32 outLen;

static void put(u8 byte) { outRegion[outLen++] = byte; }
static void put32(u32 v) {
  put((u8)v); put((u8)(v >> 8)); put((u8)(v >> 16)); put((u8)(v >> 24));
}
static void emit(u8 op, u32 al, u32 ac, u32 bl, u32 bc) {
  if (outLen + 17 > sizeof(outRegion)) { outLen = (u32)-1; return; } /* script overflow: refused by length */
  put(op); put32(al); put32(ac); put32(bl); put32(bc);
}

static int lineEq(u32 i, u32 j) {
  if (aLen[i] != bLen[j]) return 0;
  for (u32 k = 0; k < aLen[i]; k++) if (A[aOff[i] + k] != B[bOff[j] + k]) return 0;
  return 1;
}

/* Scan one text into (offset, length) per line. A trailing newline does not
   produce an empty final line; a final line without a newline is still a line. */
static u32 scan(const u8 *text, u32 len, u32 *off, u32 *lens) {
  u32 n = 0, start = 0;
  for (u32 i = 0; i < len; i++) {
    if (text[i] == '\n') { off[n] = start; lens[n] = i - start; n++; start = i + 1; }
  }
  if (start < len) { off[n] = start; lens[n] = len - start; n++; }
  return n;
}

/* In-place LCS row: row[j] = LCS length of A[aS .. aS+an) against B[bS .. bS+j). */
static void lcsRow(u32 aS, u32 an, u32 bS, u32 bn, int reverse, u32 *row) {
  for (u32 j = 0; j <= bn; j++) row[j] = 0;
  for (u32 i = 0; i < an; i++) {
    u32 ai = reverse ? (aS + an - 1 - i) : (aS + i);
    u32 prev = 0; /* the OLD row[j-1] */
    for (u32 j = 1; j <= bn; j++) {
      u32 bj = reverse ? (bS + bn - j) : (bS + j - 1);
      u32 temp = row[j]; /* the OLD row[j] */
      row[j] = row[j - 1] > row[j] ? row[j - 1] : row[j];
      if (lineEq(ai, bj) && prev + 1 > row[j]) row[j] = prev + 1;
      prev = temp;
    }
  }
}

static void emitScript(u32 aS, u32 an, u32 bS, u32 bn) {
  if (outLen == (u32)-1) return;
  if (an == 0 && bn == 0) return;
  if (an == 0) { emit(2, 0, 0, bS, bn); return; }
  if (bn == 0) { emit(1, aS, an, 0, 0); return; }

  if (an == 1) {
    u32 found = (u32)-1;
    for (u32 j = 0; j < bn; j++) if (lineEq(aS, bS + j)) { found = j; break; }
    if (found == (u32)-1) { emit(2, 0, 0, bS, bn); emit(1, aS, 1, 0, 0); return; }
    if (found > 0) emit(2, 0, 0, bS, found);
    emit(0, aS, 1, bS + found, 1);
    if (found + 1 < bn) emit(2, 0, 0, bS + found + 1, bn - found - 1);
    return;
  }
  if (bn == 1) {
    u32 found = (u32)-1;
    for (u32 i = 0; i < an; i++) if (lineEq(aS + i, bS)) { found = i; break; }
    if (found == (u32)-1) { emit(1, aS, an, 0, 0); emit(2, 0, 0, bS, 1); return; }
    if (found > 0) emit(1, aS, found, 0, 0);
    emit(0, aS + found, 1, bS, 1);
    if (found + 1 < an) emit(1, aS + found + 1, an - found - 1, 0, 0);
    return;
  }

  /* Hirschberg split: A's first half against all of B, A's second half the
     same, and the best split point of B is where the two rows sum highest. */
  u32 am = an / 2;
  lcsRow(aS, am, bS, bn, 0, fwdRow);
  lcsRow(aS + am, an - am, bS, bn, 1, revRow);
  u32 bestJ = 0, best = 0;
  for (u32 j = 0; j <= bn; j++) {
    u32 total = fwdRow[j] + revRow[bn - j];
    if (total > best) { best = total; bestJ = j; }
  }
  emitScript(aS, am, bS, bestJ);
  emitScript(aS + am, an - am, bS + bestJ, bn - bestJ);
}

__attribute__((export_name("layoutA"))) int layoutA(void) { return (int)aText; }
__attribute__((export_name("layoutB"))) int layoutB(void) { return (int)bText; }
__attribute__((export_name("layoutOut"))) int layoutOut(void) { return (int)outRegion; }

__attribute__((export_name("diff")))
int diff(int aBytes, int bBytes) {
  if (aBytes < 0 || aBytes > MAX_TEXT || bBytes < 0 || bBytes > MAX_TEXT) return -1;
  na = scan(A, (u32)aBytes, aOff, aLen);
  nb = scan(B, (u32)bBytes, bOff, bLen);
  outLen = 0;
  emitScript(0, na, 0, nb);
  if (outLen == (u32)-1) return -1;
  put(255); /* terminator */
  return (int)outLen;
}
