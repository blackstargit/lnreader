package com.margelo.nitro.nitrotts

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class SpeechPrepTest {
    @Test
    fun splitsSentencesKeepingClosingQuotes() {
        assertEquals(
            listOf("He ran.", "She said, “Stop!”", "Then left...", "Fine?"),
            splitSentences("He ran. She said, “Stop!” Then left... Fine?"),
        )
    }

    @Test
    fun cleansSymbolsForSpeech() {
        assertEquals("She said, Stop!", speakableText("She said, “Stop!!!”"))
        assertEquals("Wait. what, really, ok", speakableText("Wait… what (really) — ok"))
        assertEquals("A well-known fifty percent cut", speakableText("A well-known 50% cut ***"))
        assertEquals("It's fine.", speakableText("It’s fine…"))
        assertEquals("", speakableText("* * *"))
        assertEquals("", speakableText("———"))
    }

    @Test
    fun spellsOutNumbers() {
        assertEquals("He has twelve swords.", speakableText("He has 12 swords."))
        assertEquals(
            "one thousand two hundred five coins, the third floor, three point five meters",
            speakableText("1,205 coins, the 3rd floor, 3.5 meters"),
        )
        assertEquals("level twenty first, ninety ninth", speakableText("level 21st, 99th"))
        assertEquals("one million", numberToWords(1_000_000))
        assertEquals("fifty percent", speakableText("50%"))
    }

    @Test
    fun mergesShortSentencesIntoNeighbours() {
        assertEquals(
            listOf("Huh? It doesn't hurt as much."),
            mergeShortSentences(listOf("Huh?", "It doesn't hurt as much.")),
        )
        assertEquals(
            listOf("He looked down at it. Hehe."),
            mergeShortSentences(listOf("He looked down at it.", "Hehe.")),
        )
        assertEquals(listOf("Huh?"), mergeShortSentences(listOf("Huh?")))
    }

    @Test
    fun romanizesOnlyCjkRuns() {
        val fake: (String) -> String = { "<${it.length}>" }
        assertEquals("Lin  <2>  said hi", romanizeCjk("Lin 萧炎 said hi", fake))
        assertEquals("Kim  <1> !", romanizeCjk("Kim 김!", fake))
        assertEquals("plain text", romanizeCjk("plain text", fake))
    }

    @Test
    fun trimsWavSilenceToRequestedPadding() {
        // 1000 Hz mono: 500 silent, 100 loud, 400 silent samples.
        val samples = ShortArray(1000).also { for (i in 500 until 600) it[i] = 10_000 }
        val trimmed = trimWavSilence(wav(samples, 1000), leadMs = 10, trailMs = 50)
        val data = ByteBuffer.wrap(trimmed).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals((10 + 100 + 50) * 2, data.getInt(40))
        assertEquals(trimmed.size - 8, data.getInt(4))
        assertEquals(0, data.getShort(44 + 9 * 2).toInt())
        assertEquals(10_000, data.getShort(44 + 10 * 2).toInt())
    }

    @Test
    fun padsPauseWhenEngineLeftTooLittle() {
        // Speech runs to the very last sample: the whole pause must be added.
        val samples = ShortArray(100) { 10_000 }
        val padded = trimWavSilence(wav(samples, 1000), leadMs = 10, trailMs = 200)
        val data = ByteBuffer.wrap(padded).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals((100 + 200) * 2, data.getInt(40))
        assertEquals(0, data.getShort(padded.size - 2).toInt())
    }

    @Test
    fun leavesUnparseableAudioAloneAndShrinksSilence() {
        val garbage = byteArrayOf(1, 2, 3)
        assertSame(garbage, trimWavSilence(garbage, 10, 10))
        val silent = trimWavSilence(wav(ShortArray(2000), 1000), 10, 50)
        assertEquals(44 + 50 * 2, silent.size)
    }

    private fun wav(samples: ShortArray, sampleRate: Int): ByteArray {
        val buffer = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray()).putInt(36 + samples.size * 2).put("WAVE".toByteArray())
        buffer.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            .putInt(sampleRate).putInt(sampleRate * 2).putShort(2).putShort(16)
        buffer.put("data".toByteArray()).putInt(samples.size * 2)
        samples.forEach { buffer.putShort(it) }
        return buffer.array()
    }
}
