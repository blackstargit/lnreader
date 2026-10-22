package com.margelo.nitro.nitrotts

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes [mp3] into a 16-bit PCM WAV at [wav], so online audio goes through the same silence
 * trimming and pause handling as engine-rendered WAV files. Blocking; call off the main thread.
 */
internal fun decodeMp3ToWav(mp3: File, wav: File) {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
        extractor.setDataSource(mp3.path)
        val inputFormat = extractor.getTrackFormat(0)
        extractor.selectTrack(0)
        codec = MediaCodec.createDecoderByType(checkNotNull(inputFormat.getString(MediaFormat.KEY_MIME)))
        codec.configure(inputFormat, null, null, 0)
        codec.start()

        var sampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val pcm = ByteArrayOutputStream()
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        while (true) {
            if (!inputDone) {
                val inputIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                if (inputIndex >= 0) {
                    val size = extractor.readSampleData(checkNotNull(codec.getInputBuffer(inputIndex)), 0)
                    if (size < 0) {
                        codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        inputDone = true
                    } else {
                        codec.queueInputBuffer(inputIndex, 0, size, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val outputIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)
            if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                sampleRate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                channels = codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else if (outputIndex >= 0) {
                val buffer = checkNotNull(codec.getOutputBuffer(outputIndex))
                val chunk = ByteArray(info.size)
                buffer.position(info.offset)
                buffer.get(chunk)
                pcm.write(chunk)
                codec.releaseOutputBuffer(outputIndex, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
        }
        wav.writeBytes(wavHeader(pcm.size(), sampleRate, channels) + pcm.toByteArray())
    } finally {
        // stop() throws if configure()/start() never succeeded.
        runCatching { codec?.stop() }
        codec?.release()
        extractor.release()
    }
}

private const val TIMEOUT_US = 10_000L

internal fun wavHeader(dataBytes: Int, sampleRate: Int, channels: Int): ByteArray {
    return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        .put("RIFF".toByteArray()).putInt(36 + dataBytes).put("WAVE".toByteArray())
        .put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort())
        .putInt(sampleRate).putInt(sampleRate * channels * 2)
        .putShort((channels * 2).toShort()).putShort(16)
        .put("data".toByteArray()).putInt(dataBytes)
        .array()
}
