package com.margelo.nitro.nitrotts

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class EdgeClientTest {
    @Test
    fun buildsSsmlWithProsodyAndEscaping() {
        val message = EdgeClient.ssmlMessage("Tom & Jerry <3", "en-US-AndrewMultilingualNeural", 1.25, 0.8)
        assertTrue(message.contains("<prosody pitch='-10Hz' rate='+25%' volume='+0%'>Tom &amp; Jerry &lt;3</prosody>"))
        assertTrue(message.contains("Path:ssml\r\n\r\n<speak "))
    }

    @Test
    fun parsesVoiceList() {
        val json = """[{"Name":"x","ShortName":"en-US-AndrewMultilingualNeural","Gender":"Male",
            "Locale":"en-US"},{"ShortName":"zh-CN-liaoning-XiaobeiNeural","Locale":"zh-CN"}]"""
        assertEquals(
            listOf(
                EdgeVoice("en-US-AndrewMultilingualNeural", "en-US"),
                EdgeVoice("zh-CN-liaoning-XiaobeiNeural", "zh-CN"),
            ),
            EdgeClient.parseVoices(json),
        )
    }

    /** Hits Microsoft's real endpoint; run with EDGE_LIVE=1. */
    @Test
    fun synthesizesAgainstLiveService() {
        assumeTrue(System.getenv("EDGE_LIVE") == "1")
        val client = EdgeClient()
        assertTrue(client.listVoices().any { it.shortName == "en-US-AndrewMultilingualNeural" })

        val done = CountDownLatch(1)
        var bytes = 0
        var error: String? = null
        client.synthesize(
            "Zhou Mingrui examined the immobilized arm.",
            "en-US-AndrewMultilingualNeural",
            1.0,
            1.0,
            onDone = { bytes = it.size; done.countDown() },
            onError = { error = it; done.countDown() },
        )
        assertTrue("timed out", done.await(30, TimeUnit.SECONDS))
        assertEquals(null, error)
        assertTrue("only $bytes bytes", bytes > 6_000)
    }
}
