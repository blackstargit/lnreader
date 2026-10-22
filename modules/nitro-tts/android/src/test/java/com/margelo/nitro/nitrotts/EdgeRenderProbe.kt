package com.margelo.nitro.nitrotts

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Diagnostic, not a regression test: renders sample novel text through the same text pipeline
 * and Edge client the app uses (8 parallel), writing one MP3 + cleaned text per chunk to
 * EDGE_RENDER_OUT. Run with EDGE_RENDER_OUT=<dir>.
 */
class EdgeRenderProbe {
    private val paragraphs = listOf(
        "The throbbing pain allowed Zhou Mingrui to gradually regain his senses. Finally, he straightened his back and opened his eyes.",
        "“Huh? It doesn't hurt as much,” he muttered — then froze. His vision first blurred, then was tinged with a faint crimson glow.",
        "He saw a wooden desk in front of him with a notebook lying open on it. The pages were coarse and yellowed, with faint traces of ink bleeding through from the other side.",
        "To the left of the notebook was a stack of neatly arranged books (at least 12 of them). The wall to his right had grayish-white wallpaper that was peeling at the edges...",
        "“Everyone will die, including me,” the line read. He examined it, immobilized, for 3 or 4 minutes.",
    )

    @Test
    fun render() {
        val out = System.getenv("EDGE_RENDER_OUT")
        assumeTrue(out != null)
        val dir = File(out!!).apply { mkdirs() }
        val chunks = paragraphs.flatMapIndexed { index, paragraph ->
            val sentences = splitSentences(paragraph).map(::speakableText).filter { it.isNotEmpty() }
                .let(::mergeShortSentences)
            if (System.getenv("EDGE_RENDER_PARAGRAPHS") == "1") {
                listOf(index to sentences.joinToString(" "))
            } else {
                sentences.map { index to it }
            }
        }
        val client = EdgeClient()
        val gate = Semaphore(8)
        val done = CountDownLatch(chunks.size)
        chunks.forEachIndexed { i, (paragraph, text) ->
            gate.acquire()
            File(dir, "%03d.txt".format(i)).writeText("$paragraph\t$text")
            client.synthesize(
                text, "en-US-AndrewMultilingualNeural", 1.0, 1.0,
                onDone = { File(dir, "%03d.mp3".format(i)).writeBytes(it); gate.release(); done.countDown() },
                onError = { File(dir, "%03d.err".format(i)).writeText(it); gate.release(); done.countDown() },
            )
        }
        done.await(120, TimeUnit.SECONDS)
    }
}
