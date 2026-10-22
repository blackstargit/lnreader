package com.margelo.nitro.nitrotts

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Port of edge-tts 7.3.1 `drm.py` `generate_sec_ms_gec_v2`: the Sec-MS-GEC token Microsoft's Edge
 * Read-Aloud endpoint has required since Dec 2025. It is a modified SHA-256 plus a "CS64" checksum,
 * so java.security.MessageDigest cannot be used. Re-port it if Microsoft changes the scheme.
 */
internal object EdgeToken {
    const val TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"

    private const val WIN_EPOCH = 11644473600L
    private const val MASK = 0xFFFFFFFFL

    private val SHA256_INITIAL = longArrayOf(
        0x6A09E667L, 0xBB67AE85L, 0x3C6EF372L, 0xA54FF53AL, 0x510E527FL, 0x9B05688CL, 0x1F83D9ABL, 0x5BE0CD19L,
    )
    private val SHA256_STATE = longArrayOf(
        0xFD9FBEA2L, 0x91243CE7L, 0xBE499094L, 0xCD2E1E0AL, 0x6C006F49L, 0x04BD35ABL, 0xFEB0A7E4L, 0x03EFFBD2L,
    )
    private val SHA256_SCHEDULE = longArrayOf(
        0xEB24BF9EL, 0x1558691FL, 0xA0C09EE2L, 0x0CFA32BAL, 0xA622EE8CL, 0xD1DD9491L, 0xC0DD25A0L,
        0xF9E70AB6L, 0xF0C31573L, 0x7058CE4EL, 0x7188E606L, 0x00E5AB33L, 0xD258B060L, 0x72766564L,
    )
    private val ROUND_CONSTANTS = longArrayOf(
        0x428A2F98L, 0x71374491L, 0xB5C0FBCFL, 0xE9B5DBA5L, 0x3956C25BL, 0x59F111F1L, 0x923F82A4L, 0xAB1C5ED5L,
        0xD807AA98L, 0x12835B01L, 0x243185BEL, 0x550C7DC3L, 0x72BE5D74L, 0x80DEB1FEL, 0x9BDC06A7L, 0xC19BF174L,
        0xE49B69C1L, 0xEFBE4786L, 0x0FC19DC6L, 0x240CA1CCL, 0x2DE92C6FL, 0x4A7484AAL, 0x5CB0A9DCL, 0x76F988DAL,
        0x983E5152L, 0xA831C66DL, 0xB00327C8L, 0xBF597FC7L, 0xC6E00BF3L, 0xD5A79147L, 0x06CA6351L, 0x14292967L,
        0x27B70A85L, 0x2E1B2138L, 0x4D2C6DFCL, 0x53380D13L, 0x650A7354L, 0x766A0ABBL, 0x81C2C92EL, 0x92722C85L,
        0xA2BFE8A1L, 0xA81A664BL, 0xC24B8B70L, 0xC76C51A3L, 0xD192E819L, 0xD6990624L, 0xF40E3585L, 0x106AA070L,
        0x19A4C116L, 0x1E376C08L, 0x2748774CL, 0x34B0BCB5L, 0x391C0CB3L, 0x4ED8AA4AL, 0x5B9CCA4FL, 0x682E6FF3L,
        0x748F82EEL, 0x78A5636FL, 0x84C87814L, 0x8CC70208L, 0x90BEFFFAL, 0xA4506CEBL, 0xBEF9A3F7L, 0xC67178F2L,
    )
    private const val SHA256_ADJUSTMENT = 0xC9DC06A7L
    private val BLOCK_CONSTANTS = ROUND_CONSTANTS.copyOf().also { it[14] = SHA256_ADJUSTMENT }
    private const val SIGMA0_ADJUSTMENT = 0x059C0B80L
    private const val SIGMA1_ADJUSTMENT = 0x000B92C0L

    private val CS64_COEFFICIENTS = longArrayOf(
        0xE82E91B1L, 0x44DE24C6L, 0x3BEB65BCL, 0xC89C5933L, 0x8D1EC211L, 0x314EF5D5L, 0xE92491B1L,
        0xF0A5B9D5L, 0x06064CF3L, 0xDA79FA60L, 0xBED20560L, 0x89F9C9F8L, 0x35FA38C6L, 0xCB49E3C6L,
    )
    private val CS64_OFFSETS = longArrayOf(
        0xB32700D0L, 0x88DFF51DL, 0x29514038L, 0xB328CBDFL, 0xD405B4D5L, 0x26E55F3CL, 0x607801C6L,
        0x82B2C1FBL, 0xFA51A3DAL, 0x207CC464L, 0x3C3C74F3L, 0xD2D14B61L, 0xBB04A2C1L, 0xC5626167L,
    )
    private const val CS64_FACTOR = 0x82893933L
    private const val CS64_ADJUSTMENT0 = 0xF2F90B1AL
    private const val CS64_ADJUSTMENT1 = 0x0B1A0000L

    /** Returns "<16 hex>-<64 hex>" (uppercase) for the given unix time, like Python. */
    fun secMsGec(unixSeconds: Double): String {
        var ticks = Math.floor(unixSeconds).toLong() + WIN_EPOCH
        ticks -= Math.floorMod(ticks, 300L)
        ticks *= 10_000_000L
        val data = "$ticks$TRUSTED_CLIENT_TOKEN".toByteArray(Charsets.US_ASCII)
        val digest = sha256Digest(data)
        val (c0, c1) = cs64Digest(data, digest)
        val cs64 = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(c0.toInt()).putInt(c1.toInt()).array()
        return hex(cs64) + "-" + hex(digest)
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02X".format(it) }

    private fun rol16(v: Long): Long {
        val x = v and MASK
        return ((x shl 16) or (x ushr 16)) and MASK
    }

    private fun rotr(x: Long, n: Int) = ((x ushr n) or (x shl (32 - n))) and MASK

    private fun sigma0(v: Long) = rotr(v, 7) xor rotr(v, 18) xor (v ushr 3)
    private fun sigma1(v: Long) = rotr(v, 17) xor rotr(v, 19) xor (v ushr 10)

    private fun expandSchedule(w: LongArray, first: Int) {
        for (i in first until 64) {
            w[i] = (sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) and MASK
        }
    }

    private fun rounds(state: LongArray, w: LongArray, first: Int): LongArray {
        var a = state[0]; var b = state[1]; var c = state[2]; var d = state[3]
        var e = state[4]; var f = state[5]; var g = state[6]; var h = state[7]
        val k = if (first == 14) BLOCK_CONSTANTS else ROUND_CONSTANTS
        for (i in first until 64) {
            val t1 = h + (rotr(e, 6) xor rotr(e, 11) xor rotr(e, 25)) + (g xor (e and (f xor g))) + k[i] + w[i]
            val t2 = (rotr(a, 2) xor rotr(a, 13) xor rotr(a, 22)) + ((a and b) or (c and (a or b)))
            h = g; g = f; f = e; e = (d + t1) and MASK
            d = c; c = b; b = a; a = (t1 + t2) and MASK
        }
        return longArrayOf(a, b, c, d, e, f, g, h)
    }

    private fun be(data: ByteArray, from: Int, n: Int): Long {
        var r = 0L
        for (i in 0 until n) r = (r shl 8) or (data[from + i].toLong() and 0xFF)
        return r
    }

    private fun sha256Init(prefix: ByteArray): LongArray {
        val w = LongArray(64)
        w[14] = be(prefix, 0, 3)
        w[15] = be(prefix, 3, 4)
        for (i in 16 until 30) {
            var v = SHA256_SCHEDULE[i - 16]
            if (i - 2 >= 14) v += if (i == 16) sigma1(w[i - 2]) xor SIGMA1_ADJUSTMENT else sigma1(w[i - 2])
            if (i - 7 >= 14) v += w[i - 7]
            if (i - 15 >= 14) v += if (i == 29) sigma0(w[i - 15]) xor SIGMA0_ADJUSTMENT else sigma0(w[i - 15])
            w[i] = v and MASK
        }
        w[30] = (sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - ROUND_CONSTANTS[14]) and MASK
        expandSchedule(w, 31)
        val working = rounds(SHA256_STATE, w, 14)
        return LongArray(8) { (SHA256_INITIAL[it] + working[it]) and MASK }
    }

    private fun sha256Digest(data: ByteArray): ByteArray {
        require(data.size >= 7) { "Token salt must contain at least seven bytes" }
        val length = 57L + data.size
        val zeros = Math.floorMod(55L - length, 64L).toInt()
        val tail = data.size - 7
        val padded = ByteArray(tail + 1 + zeros + 8)
        System.arraycopy(data, 7, padded, 0, tail)
        padded[tail] = 0x80.toByte()
        ByteBuffer.wrap(padded, padded.size - 8, 8).putLong(length * 8)
        var state = sha256Init(data.copyOf(7))
        for (off in padded.indices step 64) {
            val w = LongArray(64) { if (it < 16) be(padded, off + it * 4, 4) else 0L }
            expandSchedule(w, 16)
            val working = rounds(state, w, 0)
            val prev = state
            state = LongArray(8) { (prev[it] + working[it]) and MASK }
        }
        val out = ByteBuffer.allocate(32)
        state.forEach { out.putInt(it.toInt()) }
        return out.array()
    }

    private fun cs64Digest(data: ByteArray, digest: ByteArray): Pair<Long, Long> {
        val d = ByteBuffer.wrap(digest).order(ByteOrder.LITTLE_ENDIAN)
        val keyA = (d.getInt(0).toLong() and MASK) or 1L
        val keyB = (d.getInt(4).toLong() and MASK) or 1L
        val factors = longArrayOf((keyA * CS64_FACTOR) and MASK, (keyB * CS64_FACTOR) and MASK)
        val terms = ArrayList<Long>()
        val offsets = ArrayList<Long>()
        for (i in CS64_COEFFICIENTS.indices) {
            terms += (CS64_COEFFICIENTS[i] * factors[i % 2]) and MASK
            offsets += CS64_OFFSETS[i]
        }
        // Python: b"\x00" + data, zero-padded to an even number of LE 32-bit words.
        var wordCount = (data.size + 1 + 3) / 4
        if (wordCount % 2 == 1) wordCount++
        val padded = ByteArray(wordCount * 4)
        System.arraycopy(data, 0, padded, 1, data.size)
        val buf = ByteBuffer.wrap(padded).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until wordCount) {
            val word = buf.getInt(i * 4).toLong() and MASK
            var term = word * (if (i % 2 == 0) keyA else keyB)
            var offset = rol16(word) * (if (i % 2 == 0) 0xEF0569FBL else 0xC31713DBL)
            if (i == 0) {
                term += CS64_ADJUSTMENT0 * factors[0]
                offset += CS64_ADJUSTMENT1
            }
            terms += term and MASK
            offsets += offset and MASK
        }
        var swapAcc = 0L
        var swapLast = 0L
        var state = 0L
        var acc = 0L
        for (i in terms.indices step 2) {
            val x = terms[i]
            val y = terms[i + 1]
            var t = rol16((offsets[i] + x) and MASK)
            var q = (t * 0x76F50F34L) and MASK
            swapAcc += (rol16(q) * 0xC3EFEA97L + q) and MASK
            t = rol16((offsets[i + 1] + y) and MASK)
            q = (t * 0x1881CE3CL) and MASK
            swapLast = (rol16(q) * 0x35BD1EC9L + q) and MASK
            swapAcc = (swapAcc + swapLast) and MASK

            state = (state * keyA + x) and MASK
            state = (rol16(state) * 0xCF98B111L) and MASK
            state = (rol16(state) * 0x87085B9FL) and MASK
            state = (rol16(state) * 0x12CEB96DL) and MASK
            state = (rol16(state) * 0x257E1D83L) and MASK
            acc += state
            t = (state * keyB + y) and MASK
            t = (rol16(t) * 0xA27416F5L) and MASK
            t = (rol16(t) * 0xD38396FFL) and MASK
            state = (rol16((rol16(t) * 0x7C932B89L) and MASK) * 0xBFA49F69L) and MASK
            acc = (acc + state) and MASK
        }
        return (swapLast xor state) to (swapAcc xor acc)
    }
}
