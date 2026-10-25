package com.margelo.nitro.nitrotts

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.margelo.nitro.core.Promise

internal object MainThreadPromise {
    private val handler = Handler(Looper.getMainLooper())

    fun run(operation: () -> Unit): Promise<Unit> {
        val promise = Promise<Unit>()
        handler.post {
            try {
                operation()
                promise.resolve(Unit)
            } catch (error: Throwable) {
                // The JS side only sees error.toString(); keep the stack trace for logcat.
                Log.e("nitrotts", "TTS call failed", error)
                promise.reject(error)
            }
        }
        return promise
    }
}
