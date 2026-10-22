package com.margelo.nitro.nitrotts

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs

/** Splits [text] after sentence-ending punctuation (and any closing quote/bracket). */
internal fun splitSentences(text: String): List<String> {
    return text.split(Regex("""(?<=[.!?…]["'”’)\]]?)\s+"""))
        .map { it.trim() }
        .filter { it.isNotEmpty() }
}

/**
 * Folds sentences shorter than [minWords] into the following one (or the previous one at the
 * end). Engines mangle one-word utterances like "Huh?" and pad them with long silence.
 */
internal fun mergeShortSentences(sentences: List<String>, minWords: Int = 3): List<String> {
    val merged = mutableListOf<String>()
    var pending = ""
    for (sentence in sentences) {
        val combined = if (pending.isEmpty()) sentence else "$pending $sentence"
        if (combined.split(' ').count { it.any(Char::isLetterOrDigit) } < minWords) {
            pending = combined
        } else {
            merged += combined
            pending = ""
        }
    }
    if (pending.isNotEmpty()) {
        if (merged.isEmpty()) merged += pending else merged[merged.lastIndex] += " $pending"
    }
    return merged
}

private val ONES = listOf(
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen",
)
private val TENS = listOf(
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
)
private val SCALES = listOf(
    1_000_000_000_000L to "trillion",
    1_000_000_000L to "billion",
    1_000_000L to "million",
    1_000L to "thousand",
)
private val ORDINAL_ENDINGS = mapOf(
    "one" to "first", "two" to "second", "three" to "third", "five" to "fifth",
    "eight" to "eighth", "nine" to "ninth", "twelve" to "twelfth",
)

/** 1234 → "one thousand two hundred thirty four". */
internal fun numberToWords(number: Long): String {
    if (number < 20) return ONES[number.toInt()]
    if (number < 100) {
        val ones = number % 10
        return TENS[(number / 10).toInt()] + if (ones > 0) " " + ONES[ones.toInt()] else ""
    }
    if (number < 1000) {
        val rest = number % 100
        return ONES[(number / 100).toInt()] + " hundred" + if (rest > 0) " " + numberToWords(rest) else ""
    }
    for ((scale, name) in SCALES) {
        if (number >= scale) {
            val rest = number % scale
            return numberToWords(number / scale) + " $name" + if (rest > 0) " " + numberToWords(rest) else ""
        }
    }
    return number.toString()
}

private fun ordinal(words: String): String {
    val last = words.substringAfterLast(' ')
    val head = words.dropLast(last.length)
    val ending = ORDINAL_ENDINGS[last]
        ?: if (last.endsWith("y")) last.dropLast(1) + "ieth" else last + "th"
    return head + ending
}

private val ORDINAL_NUMBER = Regex("""\b(\d{1,12})(st|nd|rd|th)\b""", RegexOption.IGNORE_CASE)
private val DECIMAL_NUMBER = Regex("""\b(\d{1,12})\.(\d+)\b""")
private val GROUPED_NUMBER = Regex("""\b\d{1,3}(,\d{3})+\b""")
private val PLAIN_NUMBER = Regex("""\d{1,12}""")

/** Spells out digits, which lexicon-based engines (e.g. Sherpa-ONNX Kokoro) skip entirely. */
internal fun spellNumbers(text: String): String {
    var result = GROUPED_NUMBER.replace(text) { it.value.replace(",", "") }
    result = ORDINAL_NUMBER.replace(result) { " " + ordinal(numberToWords(it.groupValues[1].toLong())) + " " }
    result = DECIMAL_NUMBER.replace(result) { match ->
        val digits = match.groupValues[2].map { ONES[it - '0'] }.joinToString(" ")
        " " + numberToWords(match.groupValues[1].toLong()) + " point " + digits + " "
    }
    return PLAIN_NUMBER.replace(result) { " " + numberToWords(it.value.toLong()) + " " }
}

private val CJK_SCRIPTS = setOf(
    Character.UnicodeScript.HAN,
    Character.UnicodeScript.HANGUL,
    Character.UnicodeScript.HIRAGANA,
    Character.UnicodeScript.KATAKANA,
)

/**
 * Replaces runs of Chinese/Korean/Japanese characters with [toLatin] of the run
 * (e.g. 萧炎 → "xiao yan"). English voices otherwise skip them silently.
 */
internal fun romanizeCjk(text: String, toLatin: (String) -> String): String {
    val out = StringBuilder()
    val run = StringBuilder()
    fun flush() {
        if (run.isEmpty()) return
        out.append(' ').append(toLatin(run.toString())).append(' ')
        run.setLength(0)
    }
    var i = 0
    while (i < text.length) {
        val codePoint = text.codePointAt(i)
        if (Character.UnicodeScript.of(codePoint) in CJK_SCRIPTS) {
            run.appendCodePoint(codePoint)
        } else {
            flush()
            out.appendCodePoint(codePoint)
        }
        i += Character.charCount(codePoint)
    }
    flush()
    return out.toString()
}

/** Applied in order. Engines read stray symbols as noise, so only words and basic punctuation survive. */
private val SPEECH_REPLACEMENTS = listOf(
    Regex("""[。．]""") to ".",
    Regex("""[，、]""") to ",",
    Regex("""！""") to "!",
    Regex("""？""") to "?",
    Regex("""：""") to ":",
    Regex("""；""") to ";",
    Regex("""[“”„‟«»「」『』"]""") to " ",
    Regex("""[‘’‛`´]""") to "'",
    Regex("""…+|\.{2,}""") to ".",
    Regex("""[—–―‒~]+""") to ", ",
    Regex("""[()\[\]{}<>【】〔〕〈〉《》（）]""") to ", ",
    Regex("""&""") to " and ",
    Regex("""%""") to " percent",
    Regex("""[^\p{L}\p{N}\s.,!?;:'-]""") to " ",
    Regex("""(?<!\p{L})-+|-+(?!\p{L})""") to " ",
    Regex("""([!?])[!?.]+""") to "$1",
    Regex("""\s+([,.!?;:])""") to "$1",
    Regex("""([,;:])[\s,;:]*([.!?])""") to "$2",
    Regex("""([,;:])[\s,;:]+""") to "$1 ",
    Regex("""\s+""") to " ",
)

/** Cleans [text] for an engine; returns "" when nothing speakable is left (e.g. "***"). */
internal fun speakableText(text: String): String {
    var result = spellNumbers(text)
    for ((pattern, replacement) in SPEECH_REPLACEMENTS) {
        result = pattern.replace(result, replacement)
    }
    result = result.trim().trimStart(',', '.', ';', ':', '!', '?', '\'', ' ')
    return if (result.any { it.isLetterOrDigit() }) result else ""
}

/**
 * Cuts leading silence of a 16-bit PCM WAV down to [leadMs] and sets trailing silence to exactly
 * [trailMs]. Engines pad every utterance inconsistently (too long or barely at all), so the pause
 * between sentences is set here instead. Returns [wav] itself when it can't be parsed.
 */
internal fun trimWavSilence(
    wav: ByteArray,
    leadMs: Int,
    trailMs: Int,
    threshold: Int = 300,
): ByteArray {
    if (wav.size < 12 ||
        String(wav, 0, 4, Charsets.US_ASCII) != "RIFF" ||
        String(wav, 8, 4, Charsets.US_ASCII) != "WAVE"
    ) {
        return wav
    }
    val buffer = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
    var channels = 0
    var sampleRate = 0
    var bits = 0
    var dataStart = -1
    var dataSize = 0
    var pos = 12
    while (pos + 8 <= wav.size) {
        val id = String(wav, pos, 4, Charsets.US_ASCII)
        val size = buffer.getInt(pos + 4)
        val body = pos + 8
        if (id == "fmt " && size >= 16 && body + 16 <= wav.size) {
            channels = buffer.getShort(body + 2).toInt()
            sampleRate = buffer.getInt(body + 4)
            bits = buffer.getShort(body + 14).toInt()
        } else if (id == "data") {
            dataStart = body
            dataSize = minOf(size.toLong() and 0xffffffffL, (wav.size - body).toLong()).toInt()
            break
        }
        if (size < 0) return wav
        pos = body + size + (size and 1)
    }
    if (dataStart < 0 || bits != 16 || channels < 1 || sampleRate <= 0) return wav

    val frameBytes = 2 * channels
    val frames = dataSize / frameBytes
    fun loud(frame: Int): Boolean {
        val offset = dataStart + frame * frameBytes
        return (0 until channels).any { abs(buffer.getShort(offset + it * 2).toInt()) > threshold }
    }
    val first = (0 until frames).firstOrNull(::loud)
    // All silence (the engine skipped every word) keeps nothing but the pause.
    val from = if (first == null) 0 else (first - sampleRate * leadMs / 1000).coerceAtLeast(0)
    val to = if (first == null) 0 else (frames - 1 downTo first).first(::loud) + 1
    val pauseFrames = sampleRate * trailMs / 1000

    // Exactly [trailMs] of silence after the speech, padded with zeros if the engine left less.
    val keptBytes = (to - from) * frameBytes
    val dataBytes = keptBytes + pauseFrames * frameBytes
    val out = ByteArray(dataStart + dataBytes)
    System.arraycopy(wav, 0, out, 0, dataStart)
    System.arraycopy(wav, dataStart + from * frameBytes, out, dataStart, keptBytes)
    ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).apply {
        putInt(4, out.size - 8)
        putInt(dataStart - 4, dataBytes)
    }
    return out
}
