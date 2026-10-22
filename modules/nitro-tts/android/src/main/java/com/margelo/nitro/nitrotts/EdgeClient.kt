package com.margelo.nitro.nitrotts

import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

internal data class EdgeVoice(val shortName: String, val locale: String)

/**
 * Microsoft Edge's online Read Aloud voices (the ones the Edge browser and WebNovel use).
 * Unofficial endpoint, ported from edge-tts 7.3.1; [EdgeToken] must track Microsoft's changes.
 * One WebSocket per [synthesize] call, so calls can run in parallel.
 */
internal class EdgeClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build(),
) {
    fun interface Call {
        fun cancel()
    }

    /**
     * Synthesizes [text] to MP3 (24 kHz mono). Exactly one of [onDone]/[onError] is invoked, on a
     * background thread. A request that receives nothing for [STALL_MS] fails as stalled.
     */
    fun synthesize(
        text: String,
        voice: String,
        rate: Double,
        pitch: Double,
        onDone: (ByteArray) -> Unit,
        onError: (String) -> Unit,
    ): Call {
        val finished = AtomicBoolean(false)
        val audio = ByteArrayOutputStream()
        var watchdog: ScheduledFuture<*>? = null
        var socket: WebSocket? = null

        fun finish(error: String?) {
            if (!finished.compareAndSet(false, true)) return
            watchdog?.cancel(false)
            socket?.cancel()
            if (error != null) {
                onError(error)
            } else {
                onDone(synchronized(audio) { audio.toByteArray() })
            }
        }

        fun armWatchdog() {
            watchdog?.cancel(false)
            watchdog = timer.schedule({ finish("stalled") }, STALL_MS, TimeUnit.MILLISECONDS)
        }

        val request = Request.Builder()
            .url(
                "$WSS_URL&ConnectionId=${connectId()}" +
                    "&Sec-MS-GEC=${EdgeToken.secMsGec(now())}&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION",
            )
            .apply { wssHeaders().forEach { (name, value) -> header(name, value) } }
            .build()

        socket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    armWatchdog()
                    webSocket.send(configMessage())
                    webSocket.send(ssmlMessage(text, voice, rate, pitch))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    armWatchdog()
                    if (!text.contains("Path:turn.end")) return
                    val empty = synchronized(audio) { audio.size() == 0 }
                    finish(if (empty) "no audio received" else null)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    armWatchdog()
                    val data = bytes.toByteArray()
                    if (data.size < 2) return
                    val headerLength = ((data[0].toInt() and 0xff) shl 8) or (data[1].toInt() and 0xff)
                    val bodyStart = 2 + headerLength
                    if (bodyStart >= data.size) return
                    if (!String(data, 2, headerLength, Charsets.UTF_8).contains("Path:audio")) return
                    synchronized(audio) { audio.write(data, bodyStart, data.size - bodyStart) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    // 403 usually means our clock is off; the token is time-based.
                    if (response?.code == 403) adjustClockSkew(response.header("Date"))
                    finish(response?.let { "HTTP ${it.code}" } ?: (t.message ?: t.javaClass.simpleName))
                }
            },
        )
        armWatchdog()
        return Call { finish("cancelled") }
    }

    /** Blocking; call off the main thread. */
    fun listVoices(): List<EdgeVoice> {
        val request = Request.Builder()
            .url("$VOICE_LIST_URL&Sec-MS-GEC=${EdgeToken.secMsGec(now())}&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION")
            .apply { voiceHeaders().forEach { (name, value) -> header(name, value) } }
            .build()
        http.newCall(request).execute().use { response ->
            if (response.code == 403) adjustClockSkew(response.header("Date"))
            check(response.isSuccessful) { "Microsoft voice list failed: HTTP ${response.code}" }
            return parseVoices(response.body?.string().orEmpty())
        }
    }

    companion object {
        const val STALL_MS = 8_000L
        private const val BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
        private const val WSS_URL = "wss://$BASE_URL/edge/v1?TrustedClientToken=${EdgeToken.TRUSTED_CLIENT_TOKEN}"
        private const val VOICE_LIST_URL =
            "https://$BASE_URL/voices/list?trustedclienttoken=${EdgeToken.TRUSTED_CLIENT_TOKEN}"
        private const val CHROMIUM_FULL_VERSION = "143.0.3650.75"
        private const val CHROMIUM_MAJOR_VERSION = "143"
        private const val SEC_MS_GEC_VERSION = "2-$CHROMIUM_FULL_VERSION"
        private const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
            " (KHTML, like Gecko) Chrome/$CHROMIUM_MAJOR_VERSION.0.0.0 Safari/537.36" +
            " Edg/$CHROMIUM_MAJOR_VERSION.0.0.0"

        private val timer = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "edge-tts-watchdog").apply { isDaemon = true }
        }

        @Volatile
        private var clockSkewSeconds = 0.0

        private fun now(): Double = System.currentTimeMillis() / 1000.0 + clockSkewSeconds

        private fun adjustClockSkew(serverDate: String?) {
            val parsed = serverDate?.let {
                runCatching { httpDateFormat().parse(it) }.getOrNull()
            } ?: return
            clockSkewSeconds += parsed.time / 1000.0 - now()
        }

        private fun httpDateFormat() = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)

        private fun connectId() = UUID.randomUUID().toString().replace("-", "")

        private fun muid() = UUID.randomUUID().toString().replace("-", "").uppercase(Locale.US)

        private fun baseHeaders() = listOf(
            "User-Agent" to USER_AGENT,
            "Accept-Encoding" to "gzip, deflate, br, zstd",
            "Accept-Language" to "en-US,en;q=0.9",
            "Cookie" to "muid=${muid()};",
        )

        private fun wssHeaders() = listOf(
            "Pragma" to "no-cache",
            "Cache-Control" to "no-cache",
            "Origin" to "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        ) + baseHeaders()

        private fun voiceHeaders() = listOf(
            "Authority" to "speech.platform.bing.com",
            "Sec-CH-UA" to "\" Not;A Brand\";v=\"99\", \"Microsoft Edge\";v=\"$CHROMIUM_MAJOR_VERSION\"," +
                " \"Chromium\";v=\"$CHROMIUM_MAJOR_VERSION\"",
            "Sec-CH-UA-Mobile" to "?0",
            "Accept" to "*/*",
            "Sec-Fetch-Site" to "none",
            "Sec-Fetch-Mode" to "cors",
            "Sec-Fetch-Dest" to "empty",
        ) + baseHeaders()

        /** JavaScript-style UTC date, as the Edge extension sends it. */
        private fun timestamp(): String {
            val format = SimpleDateFormat("EEE MMM dd yyyy HH:mm:ss", Locale.US)
            format.timeZone = TimeZone.getTimeZone("UTC")
            return format.format(Date()) + " GMT+0000 (Coordinated Universal Time)"
        }

        private fun configMessage() =
            "X-Timestamp:${timestamp()}\r\n" +
                "Content-Type:application/json; charset=utf-8\r\n" +
                "Path:speech.config\r\n\r\n" +
                "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{" +
                "\"sentenceBoundaryEnabled\":\"true\",\"wordBoundaryEnabled\":\"false\"}," +
                "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n"

        internal fun ssmlMessage(text: String, voice: String, rate: Double, pitch: Double): String {
            // The service rejects values outside roughly these ranges.
            val ratePercent = ((rate - 1.0) * 100).roundToInt().coerceIn(-90, 200)
            val pitchHz = ((pitch - 1.0) * 50).roundToInt().coerceIn(-50, 50)
            val ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
                "<voice name='${escapeXml(voice)}'>" +
                "<prosody pitch='${signed(pitchHz)}Hz' rate='${signed(ratePercent)}%' volume='+0%'>" +
                escapeXml(text) +
                "</prosody></voice></speak>"
            // The trailing "Z" on X-Timestamp mirrors a quirk of the Edge extension.
            return "X-RequestId:${connectId()}\r\n" +
                "Content-Type:application/ssml+xml\r\n" +
                "X-Timestamp:${timestamp()}Z\r\n" +
                "Path:ssml\r\n\r\n" +
                ssml
        }

        private fun signed(value: Int) = if (value >= 0) "+$value" else "$value"

        /** XML-escapes [text] and blanks control characters the service rejects. */
        internal fun escapeXml(text: String): String {
            val out = StringBuilder(text.length)
            for (char in text) {
                when {
                    char == '&' -> out.append("&amp;")
                    char == '<' -> out.append("&lt;")
                    char == '>' -> out.append("&gt;")
                    char.code < 32 && char != '\t' && char != '\n' && char != '\r' -> out.append(' ')
                    else -> out.append(char)
                }
            }
            return out.toString()
        }

        internal fun parseVoices(json: String): List<EdgeVoice> {
            val shortNames = Regex(""""ShortName"\s*:\s*"([^"]+)"""").findAll(json).map { it.groupValues[1] }
            return shortNames
                .map { EdgeVoice(it, it.split('-').take(2).joinToString("-")) }
                .distinct()
                .toList()
        }
    }
}
