/**
 * Native speech preferences applied to every queued paragraph.
 *
 * @see {@linkcode TtsSession.updateSettings}
 */
export interface TtsSettings {
  /**
   * Android only: engine package name from {@linkcode TtsFactory.getEngines},
   * or the system default when absent. Ignored on iOS.
   */
  engineName?: string;
  /** Platform voice identifier, or the platform default when absent. */
  voiceIdentifier?: string;
  /** Speech-rate multiplier selected by the reader. */
  rate: number;
  /** Voice-pitch multiplier selected by the reader. */
  pitch: number;
  /** Android only: silence after each sentence, in milliseconds. Ignored on iOS. */
  sentencePauseMs: number;
  /** Android only: silence after each paragraph, in milliseconds. Ignored on iOS. */
  paragraphPauseMs: number;
}
