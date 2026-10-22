package com.margelo.nitro.nitrotts

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.io.IOException
import java.util.Locale

/**
 * Plays a chapter by synthesizing sentence chunks to files ahead of playback and playing them
 * with chained [MediaPlayer]s. Speaking through [TextToSpeech.speak] instead would leave the
 * engine only ~500ms of buffered audio (MAX_UNCONSUMED_AUDIO_MS in the framework's playback
 * queue), so any engine slower than that per sentence produces an audible gap after every sentence.
 */
internal object TtsPlaybackStore {
    /**
     * Sentence chunks synthesized ahead of the one currently playing. Large because on-device
     * engines run close to real time (Kokoro on a Pixel: ~0.8–1.1 s of work per second of
     * audio); the buffer built up during fast stretches absorbs slow ones (short sentences,
     * thermal throttling) instead of draining after a few paragraphs. ~300 KB per chunk.
     */
    private const val LOOKAHEAD = 12

    /**
     * Silence kept before each sentence, replacing the engine's own padding. The pauses after
     * sentences and paragraphs come from [TtsSettings] (reader TTS settings).
     */
    private const val SENTENCE_LEAD_MS = 30
    private const val MAX_PAUSE_MS = 5000

    private data class Chunk(val paragraph: Int, val text: String)

    private val speechAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private val ownerHandler = Handler(Looper.getMainLooper())
    private val stateListeners = TtsListenerRegistry<TtsPlaybackState>()
    private val progressListeners = TtsListenerRegistry<TtsProgress>()
    private val errorListeners = TtsListenerRegistry<String>()
    private val snapshotListeners = TtsListenerRegistry<TtsPlaybackSnapshot>()
    private val pendingInitialization = mutableListOf<(Result<Unit>) -> Unit>()

    private var applicationContext: Context? = null
    private var engine: TextToSpeech? = null
    private var boundEngineName: String? = null
    private var isReady = false
    private var paragraphs: List<TtsParagraph> = emptyList()
    private var currentIndex = 0
    private var chunks: List<Chunk> = emptyList()
    private var playChunk = 0
    private var nextToSynthesize = 0
    private val synthesized = mutableSetOf<Int>()
    private var player: MediaPlayer? = null
    /** Prepared player for `playChunk + 1`, handed to [player] via setNextMediaPlayer. */
    private var nextPlayer: MediaPlayer? = null
    /** Paused with player and synthesized chunks kept, so [play] resumes instantly. */
    private var pausedInPlace = false
    private var metadata: TtsMetadata? = null
    private var settings = TtsSettings(null, null, 1.0, 1.0, 200.0, 400.0)
    private var state = TtsPlaybackState.IDLE
    private var generation = 0L

    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private var resumeOnFocusGain = false

    fun prepare(context: Context, completion: (Result<Unit>) -> Unit) {
        runOnOwner {
            applicationContext = context.applicationContext
            if (audioManager == null) {
                audioManager =
                    applicationContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            }
            if (isReady && boundEngineName == settings.engineName) {
                completion(Result.success(Unit))
                return@runOnOwner
            }

            pendingInitialization.add(completion)
            bindEngine(settings.engineName)
        }
    }

    /** Lists text-to-speech engines installed on the device. */
    fun listEngines(context: Context): List<TtsEngine> {
        val packageManager = context.packageManager
        val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
        val resolveInfos = packageManager.queryIntentServices(
            intent,
            PackageManager.GET_META_DATA,
        )
        return resolveInfos
            .map { resolveInfo ->
                TtsEngine(
                    name = resolveInfo.serviceInfo.packageName,
                    label = resolveInfo.serviceInfo.loadLabel(packageManager).toString(),
                )
            }
            .distinctBy { it.name }
            .sortedBy { it.label.lowercase() }
    }

    /** Lists voices offered by `engineName`, probing it independently of the active engine. */
    fun listVoices(
        context: Context,
        engineName: String?,
        completion: (Result<List<TtsVoice>>) -> Unit,
    ) {
        runOnOwner {
            var probe: TextToSpeech? = null
            val listener = TextToSpeech.OnInitListener { status ->
                runOnOwner {
                    val result = if (status == TextToSpeech.SUCCESS) {
                        val voices = probe?.voices
                            ?.map { voice ->
                                TtsVoice(
                                    identifier = voice.name,
                                    name = voice.name,
                                    language = voice.locale?.toLanguageTag(),
                                )
                            }
                            ?.sortedBy { it.name }
                            ?: emptyList()
                        Result.success(voices)
                    } else {
                        Result.failure(
                            IllegalStateException("The selected text-to-speech engine failed to initialize."),
                        )
                    }
                    probe?.shutdown()
                    probe = null
                    completion(result)
                }
            }
            probe = if (engineName != null) {
                TextToSpeech(context.applicationContext, listener, engineName)
            } else {
                TextToSpeech(context.applicationContext, listener)
            }
        }
    }

    /** (Re)binds [engine] to [engineName], shutting down any previously bound engine. */
    private fun bindEngine(engineName: String?) {
        val context = checkNotNull(applicationContext)
        isReady = false
        engine?.stop()
        engine?.shutdown()
        engine = null

        val listener = TextToSpeech.OnInitListener { status ->
            runOnOwner {
                if (status == TextToSpeech.SUCCESS) {
                    isReady = true
                    boundEngineName = engineName
                    engine?.setOnUtteranceProgressListener(progressListener)
                    completeInitialization(Result.success(Unit))
                } else {
                    engine = null
                    completeInitialization(
                        Result.failure(
                            IllegalStateException("The selected text-to-speech engine failed to initialize."),
                        ),
                    )
                }
            }
        }
        engine = if (engineName != null) {
            TextToSpeech(context, listener, engineName)
        } else {
            TextToSpeech(context, listener)
        }
    }

    fun load(
        nextParagraphs: Array<TtsParagraph>,
        initialIndex: Int,
        nextMetadata: TtsMetadata,
        nextSettings: TtsSettings,
    ) {
        requireReady()
        require(nextParagraphs.isNotEmpty()) { "The TTS queue cannot be empty." }

        halt()
        paragraphs = nextParagraphs.filter { it.text.isNotBlank() }
        require(paragraphs.isNotEmpty()) { "The TTS queue contains no readable paragraphs." }
        chunks = paragraphs.flatMapIndexed { index, paragraph ->
            splitSentences(paragraph.text).ifEmpty { listOf(paragraph.text) }
                .map(::prepareForSpeech)
                .filter { it.isNotEmpty() }
                .let(::mergeShortSentences)
                .map { Chunk(index, it) }
        }
        require(chunks.isNotEmpty()) { "The TTS queue contains no readable paragraphs." }
        currentIndex = initialIndex.coerceIn(paragraphs.indices)
        playChunk = firstChunkOf(currentIndex)
        metadata = nextMetadata
        settings = nextSettings
        state = TtsPlaybackState.PAUSED
        emitProgress()
        emitState()

        val context = checkNotNull(applicationContext)
        TtsPlaybackService.start(context)
    }

    fun play() {
        requireReady()
        check(paragraphs.isNotEmpty()) { "Load a paragraph queue before starting TTS." }
        if (pausedInPlace) {
            resumeInPlace()
            return
        }
        // Resume at the paused sentence unless the user has moved to another paragraph since.
        if (chunks.getOrNull(playChunk)?.paragraph == currentIndex) {
            speakFrom(playChunk)
        } else {
            speakCurrent()
        }
    }

    /**
     * Manual pause (from the user, media notification, or MediaSession controls).
     * Always wins over a later focus regain — even if we're currently paused because of a
     * transient focus loss (e.g. a call), calling this makes sure TTS stays paused once the
     * call ends instead of auto-resuming.
     */
    fun pause() {
        resumeOnFocusGain = false
        abandonAudioFocus()
        pauseEngine()
    }

    fun stop() {
        halt()
        clearAudioCache()
        paragraphs = emptyList()
        chunks = emptyList()
        currentIndex = 0
        metadata = null
        state = TtsPlaybackState.IDLE
        resumeOnFocusGain = false
        abandonAudioFocus()
        emitState()
        applicationContext?.let { TtsPlaybackService.stop(it) }
    }

    /**
     * Pauses playback without touching audio focus. Keeps the player and synthesized chunks:
     * the engine can't be interrupted mid-sentence, so re-synthesizing on resume would also wait
     * for whatever it is still generating (several seconds with slow engines).
     */
    private fun pauseEngine() {
        if (state != TtsPlaybackState.PLAYING) {
            return
        }
        player?.pause()
        pausedInPlace = true
        state = TtsPlaybackState.PAUSED
        emitState()
    }

    private fun resumeInPlace() {
        if (!requestAudioFocus()) {
            fail("Couldn't get audio focus - another app or call may be using audio.")
            return
        }
        pausedInPlace = false
        state = TtsPlaybackState.PLAYING
        resumeOnFocusGain = false
        emitState()
        val current = player
        if (current != null) {
            current.start()
        } else if (playChunk in synthesized) {
            startPlayer()
        }
        // Otherwise onChunkSynthesized starts it when the engine finishes.
    }

    /** Invalidates in-flight callbacks, cancels pending synthesis and releases the players. */
    private fun halt() {
        generation += 1
        engine?.stop()
        player?.release()
        player = null
        nextPlayer?.release()
        nextPlayer = null
        synthesized.clear()
        pausedInPlace = false
    }

    /**
     * Requests playback focus so the system can tell us to pause for a call or other audio
     * that genuinely needs exclusive use of the speaker. Duck-only interruptions (notification
     * sounds, alerts) are left alone - see [handleAudioFocusChange].
     */
    private fun requestAudioFocus(): Boolean {
        if (hasAudioFocus) return true
        val manager = audioManager ?: return false

        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(speechAttributes)
                .setOnAudioFocusChangeListener(audioFocusChangeListener, ownerHandler)
                .build()
            audioFocusRequest = request
            manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        hasAudioFocus = granted
        return granted
    }

    private fun abandonAudioFocus() {
        if (!hasAudioFocus) return
        val manager = audioManager
        if (manager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioFocusRequest?.let { manager.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                manager.abandonAudioFocus(audioFocusChangeListener)
            }
        }
        hasAudioFocus = false
    }

    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        runOnOwner { handleAudioFocusChange(focusChange) }
    }

    private fun handleAudioFocusChange(focusChange: Int) {
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // Another app now owns audio focus outright (e.g. a call was answered).
                hasAudioFocus = false
                resumeOnFocusGain = false
                pauseEngine()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // Something needs exclusive use of the speaker for a short while
                // Pause and remember to resume once it's done.
                resumeOnFocusGain = state == TtsPlaybackState.PLAYING
                pauseEngine()
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
                if (resumeOnFocusGain) {
                    resumeOnFocusGain = false
                    play()
                }
            }
        }
    }

    fun skipPrevious() {
        check(paragraphs.isNotEmpty()) { "Load a paragraph queue before seeking." }
        currentIndex = (currentIndex - 1).coerceAtLeast(0)
        speakCurrent()
    }

    fun skipNext() {
        check(paragraphs.isNotEmpty()) { "Load a paragraph queue before seeking." }
        if (currentIndex >= paragraphs.lastIndex) {
            completeQueue()
            return
        }
        currentIndex += 1
        speakCurrent()
    }

    fun replayCurrent() {
        check(paragraphs.isNotEmpty()) { "Load a paragraph queue before replaying." }
        speakCurrent()
    }

    fun seekTo(index: Int) {
        check(paragraphs.isNotEmpty()) { "Load a paragraph queue before seeking." }
        currentIndex = index.coerceIn(paragraphs.indices)
        speakCurrent()
    }

    fun updateSettings(nextSettings: TtsSettings) {
        requireReady()
        // The reader sends this on any reader-setting change; don't restart for no-ops.
        if (nextSettings == settings) return
        val pausesOnly = nextSettings.copy(
            sentencePauseMs = settings.sentencePauseMs,
            paragraphPauseMs = settings.paragraphPauseMs,
        ) == settings
        val shouldResume = state == TtsPlaybackState.PLAYING
        settings = nextSettings
        // Pauses apply to chunks as they finish synthesizing; no need to restart for them.
        if (pausesOnly) return
        if (shouldResume) {
            speakFrom(playChunk)
        } else if (pausedInPlace) {
            // Chunks were synthesized with the old voice/rate; play() re-synthesizes.
            halt()
        }
    }

    fun addStateListener(listener: (TtsPlaybackState) -> Unit): () -> Unit {
        runOnOwner { listener(state) }
        return stateListeners.add(listener)
    }

    fun addProgressListener(listener: (TtsProgress) -> Unit): () -> Unit {
        runOnOwner { currentProgress()?.let(listener) }
        return progressListeners.add(listener)
    }

    fun addErrorListener(listener: (String) -> Unit): () -> Unit {
        return errorListeners.add(listener)
    }

    fun addSnapshotListener(listener: (TtsPlaybackSnapshot) -> Unit): () -> Unit {
        listener(snapshot())
        return snapshotListeners.add(listener)
    }

    fun snapshot(): TtsPlaybackSnapshot {
        return TtsPlaybackSnapshot(state, metadata, currentProgress())
    }

    private fun speakCurrent() = speakFrom(firstChunkOf(currentIndex))

    /** First chunk of [paragraph], or of the next paragraph if it had nothing speakable. */
    private fun firstChunkOf(paragraph: Int): Int {
        val index = chunks.indexOfFirst { it.paragraph >= paragraph }
        return if (index < 0) chunks.lastIndex else index
    }

    private fun speakFrom(chunkIndex: Int) {
        if (engine == null || settings.engineName != boundEngineName) {
            pendingInitialization.add { result ->
                result.fold(
                    onSuccess = { speakFrom(chunkIndex) },
                    onFailure = { fail("The selected text-to-speech engine failed to initialize.") },
                )
            }
            bindEngine(settings.engineName)
            return
        }

        if (!requestAudioFocus()) {
            fail("Couldn't get audio focus - another app or call may be using audio.")
            return
        }

        halt()
        clearAudioCache()
        val activeEngine = checkNotNull(engine)
        activeEngine.setSpeechRate(settings.rate.toFloat().coerceIn(0.1f, 4.0f))
        activeEngine.setPitch(settings.pitch.toFloat().coerceIn(0.1f, 2.0f))
        applyVoice(activeEngine)

        playChunk = chunkIndex.coerceIn(chunks.indices)
        nextToSynthesize = playChunk
        currentIndex = chunks[playChunk].paragraph
        state = TtsPlaybackState.PLAYING
        resumeOnFocusGain = false
        emitProgress()
        emitState()
        synthesizeAhead()
    }

    /** Keeps up to [LOOKAHEAD] chunks after the playing one queued for synthesis. */
    private fun synthesizeAhead() {
        val activeEngine = engine ?: return
        val last = (playChunk + LOOKAHEAD).coerceAtMost(chunks.lastIndex)
        while (nextToSynthesize <= last) {
            val index = nextToSynthesize
            val result = activeEngine.synthesizeToFile(
                chunks[index].text,
                Bundle(),
                chunkFile(index),
                utteranceId(generation, index),
            )
            if (result == TextToSpeech.ERROR) {
                fail("The text-to-speech engine rejected the current paragraph.")
                return
            }
            nextToSynthesize += 1
        }
    }

    private fun onChunkSynthesized(utteranceId: String) {
        val index = chunkIndexOf(utteranceId) ?: return
        val endsParagraph = chunks.getOrNull(index + 1)?.paragraph != chunks[index].paragraph
        val pauseMs = if (endsParagraph) settings.paragraphPauseMs else settings.sentencePauseMs
        setPauses(chunkFile(index), pauseMs.toInt().coerceIn(0, MAX_PAUSE_MS))
        synthesized += index
        if (player == null && index == playChunk && state == TtsPlaybackState.PLAYING) {
            startPlayer()
        } else if (index == playChunk + 1) {
            chainNext()
        }
    }

    private fun setPauses(file: File, pauseMs: Int) {
        try {
            val wav = file.readBytes()
            val trimmed = trimWavSilence(wav, SENTENCE_LEAD_MS, pauseMs)
            if (trimmed !== wav) file.writeBytes(trimmed)
        } catch (cause: IOException) {
            // Untrimmed audio still plays with the engine's own pauses.
        }
    }

    private fun startPlayer() {
        markParagraphPlaying()
        val file = chunkFile(playChunk)
        val current = preparePlayer(playChunk)
        if (current == null) {
            // Unplayable (e.g. empty) audio: skip the chunk.
            onChunkFinished(file)
            return
        }
        player = current
        current.start()
        chainNext()
    }

    private fun preparePlayer(index: Int): MediaPlayer? {
        val file = chunkFile(index)
        val queueGeneration = generation
        val prepared = MediaPlayer()
        return try {
            prepared.setAudioAttributes(speechAttributes)
            prepared.setDataSource(file.path)
            prepared.prepare()
            prepared.setOnCompletionListener {
                if (queueGeneration == generation) onChunkFinished(file)
            }
            prepared
        } catch (cause: Exception) {
            prepared.release()
            null
        }
    }

    /** Hands the next chunk's player to the current one, so Android starts it with no gap. */
    private fun chainNext() {
        val current = player ?: return
        val index = playChunk + 1
        if (nextPlayer != null || index !in synthesized) return
        val prepared = preparePlayer(index) ?: return
        current.setNextMediaPlayer(prepared)
        nextPlayer = prepared
    }

    private fun onChunkFinished(file: File) {
        player?.release()
        player = null
        file.delete()
        if (playChunk >= chunks.lastIndex) {
            completeQueue()
            return
        }
        playChunk += 1
        synthesizeAhead()
        val chained = nextPlayer
        nextPlayer = null
        if (chained != null) {
            // Already started by setNextMediaPlayer.
            player = chained
            if (state != TtsPlaybackState.PLAYING) chained.pause()
            markParagraphPlaying()
            chainNext()
        } else if (playChunk in synthesized) {
            startPlayer()
        }
        // Otherwise onChunkSynthesized starts it when the engine finishes.
    }

    private fun markParagraphPlaying() {
        val paragraph = chunks[playChunk].paragraph
        if (paragraph != currentIndex) {
            currentIndex = paragraph
            emitProgress()
        }
    }

    private val cjkToLatin: ((String) -> String)? by lazy {
        // android.icu.text.Transliterator is API 29+.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@lazy null
        val anyToLatin = android.icu.text.Transliterator.getInstance("Any-Latin")
        val latinToAscii = android.icu.text.Transliterator.getInstance("Latin-ASCII")
        val transliterate: (String) -> String = {
            latinToAscii.transliterate(anyToLatin.transliterate(it))
        }
        transliterate
    }

    private fun prepareForSpeech(text: String): String {
        val romanized = cjkToLatin?.let { romanizeCjk(text, it) } ?: text
        return speakableText(romanized)
    }

    private fun chunkIndexOf(utteranceId: String): Int? {
        val prefix = "lnreader-$generation-"
        if (!utteranceId.startsWith(prefix)) return null
        return utteranceId.removePrefix(prefix).toIntOrNull()
    }

    private fun audioCacheDir(): File {
        return File(checkNotNull(applicationContext).cacheDir, "tts").apply { mkdirs() }
    }

    private fun chunkFile(index: Int): File = File(audioCacheDir(), "$generation-$index.wav")

    private fun clearAudioCache() {
        applicationContext?.let { audioCacheDir().listFiles()?.forEach(File::delete) }
    }

    private fun applyVoice(activeEngine: TextToSpeech) {
        val voiceIdentifier = settings.voiceIdentifier
        if (voiceIdentifier.isNullOrBlank()) {
            activeEngine.setLanguage(Locale.getDefault())
            return
        }

        val selectedVoice = activeEngine.voices?.firstOrNull {
            it.name == voiceIdentifier
        }
        if (selectedVoice != null) {
            activeEngine.voice = selectedVoice
        }
    }

    private fun completeQueue() {
        halt()
        state = TtsPlaybackState.COMPLETED
        emitState()
        applicationContext?.let { TtsPlaybackService.stop(it) }
    }

    private fun fail(message: String) {
        halt()
        state = TtsPlaybackState.ERROR
        errorListeners.emit(message)
        emitState()
    }

    private fun emitState() {
        stateListeners.emit(state)
        snapshotListeners.emit(snapshot())
    }

    private fun emitProgress() {
        val progress = currentProgress() ?: return
        progressListeners.emit(progress)
        snapshotListeners.emit(snapshot())
    }

    private fun currentProgress(): TtsProgress? {
        val paragraph = paragraphs.getOrNull(currentIndex) ?: return null
        return TtsProgress(
            index = currentIndex.toDouble(),
            total = paragraphs.size.toDouble(),
            paragraphId = paragraph.id,
        )
    }

    private fun utteranceId(queueGeneration: Long, index: Int): String {
        return "lnreader-$queueGeneration-$index"
    }

    private fun completeInitialization(result: Result<Unit>) {
        val callbacks = pendingInitialization.toList()
        pendingInitialization.clear()
        callbacks.forEach { it(result) }
    }

    private fun requireReady() {
        check(isReady) { "The text-to-speech engine is not ready." }
    }

    private fun runOnOwner(operation: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            operation()
        } else {
            ownerHandler.post(operation)
        }
    }

    private val progressListener = object : UtteranceProgressListener() {
        // Synthesis-to-file start; playback state is driven by the player instead.
        override fun onStart(utteranceId: String) = Unit

        override fun onDone(utteranceId: String) {
            runOnOwner { onChunkSynthesized(utteranceId) }
        }

        @Deprecated("Deprecated by Android")
        override fun onError(utteranceId: String) {
            runOnOwner { handleError(utteranceId, "The text-to-speech engine failed while speaking.") }
        }

        override fun onError(utteranceId: String, errorCode: Int) {
            runOnOwner {
                handleError(utteranceId, "The text-to-speech engine failed with error code $errorCode.")
            }
        }
    }

    private fun handleError(utteranceId: String, message: String) {
        if (chunkIndexOf(utteranceId) != null) {
            fail(message)
        }
    }
}