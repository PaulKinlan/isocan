// sha256.c — a real, pure SHA-256 for the isocan wasm tool surface.
//
// ABI (deliberately boring, no imports, deterministic):
//   memory layout: input at 1024, digest written at INPUT_ADDR + 8192
//   exported: sha256(len) — hashes `len` bytes at 1024, writes 32 bytes at 8448
//   exported: addresses() — returns 1024<<16 | 8448 so the host never hardcodes
//
// Build (see build.sh):
//   clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export-memory \
//     -Wl,--export=sha256 -Wl,--export=addresses hash.wasm
//
// Purity: no imports table, no clock, no randomness; same bytes in, same
// digest out, on any host. That is the whole point of picking hash as the
// first real tool (54k.2, tool four).

typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned char u8;

#define INPUT_ADDR 1024
#define OUT_ADDR (INPUT_ADDR + 8192)
#define MAX_INPUT 8192

static const u32 K[64] = {
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

static u32 rotr(u32 x, u32 n) { return (x >> n) | (x << (32 - n)); }

static void compress(u32 *h, const u8 *block) {
  u32 w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = ((u32)block[i*4] << 24) | ((u32)block[i*4+1] << 16) | ((u32)block[i*4+2] << 8) | (u32)block[i*4+3];
  }
  for (int i = 16; i < 64; i++) {
    u32 s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3);
    u32 s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  u32 a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    u32 S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    u32 ch = (e & f) ^ (~e & g);
    u32 t1 = hh + S1 + ch + K[i] + w[i];
    u32 S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    u32 maj = (a & b) ^ (a & c) ^ (b & c);
    u32 t2 = S0 + maj;
    hh = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

__attribute__((export_name("addresses")))
int addresses(void) { return (INPUT_ADDR << 16) | (OUT_ADDR & 0xffff) | ((OUT_ADDR & 0xf0000) << 4); }

__attribute__((export_name("sha256")))
int sha256(int len) {
  if (len < 0 || len > MAX_INPUT) return -1;
  static const u8 init_h[32] = {
    0x6a,0x09,0xe6,0x67, 0xbb,0x67,0xae,0x85, 0x3c,0x6e,0xf3,0x72, 0xa5,0x4f,0xf5,0x3a,
    0x51,0x0e,0x52,0x7f, 0x9b,0x05,0x68,0x8c, 0x1f,0x83,0xd9,0xab, 0x5b,0xe0,0xcd,0x19
  };
  u32 h[8];
  for (int i = 0; i < 8; i++) {
    h[i] = ((u32)init_h[i*4] << 24) | ((u32)init_h[i*4+1] << 16) | ((u32)init_h[i*4+2] << 8) | (u32)init_h[i*4+3];
  }

  u8 *input = (u8 *)INPUT_ADDR;
  u64 bitlen = (u64)len * 8;

  /* full blocks */
  int i = 0;
  for (; i + 64 <= len; i += 64) compress(h, input + i);

  /* tail: copy rest, append 0x80, zeros, 8-byte big-endian bit length */
  u8 tail[128];
  u64 rem = (u64)(len - i);
  for (u64 j = 0; j < rem; j++) tail[j] = input[i + j];
  tail[rem] = 0x80;
  u64 padded = (rem + 1 <= 56) ? 64 : 128;
  for (u64 j = rem + 1; j < padded - 8; j++) tail[j] = 0;
  for (int j = 0; j < 8; j++) tail[padded - 1 - j] = (u8)(bitlen >> (8 * j));
  compress(h, tail);
  if (padded == 128) compress(h, tail + 64);

  u8 *out = (u8 *)OUT_ADDR;
  for (int j = 0; j < 8; j++) {
    out[j*4]   = (u8)(h[j] >> 24);
    out[j*4+1] = (u8)(h[j] >> 16);
    out[j*4+2] = (u8)(h[j] >> 8);
    out[j*4+3] = (u8)(h[j]);
  }
  return 32;
}
