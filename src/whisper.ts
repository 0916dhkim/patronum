/**
 * Transcription module for OpenAI Whisper API.
 * Handles voice-to-text conversion for Telegram voice messages.
 */

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";

export async function transcribeAudio(
  audioBuffer: Buffer,
  openaiApiKey: string,
  filename: string = "audio.ogg"
): Promise<string> {
  // Create FormData with the audio file
  const form = new FormData();

  // Create a Blob from the buffer with the correct MIME type
  // Use the buffer as-is — FormData will handle it
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg; codecs=opus" });
  form.append("file", blob, filename);
  form.append("model", "whisper-1");

  try {
    const response = await fetch(WHISPER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as { text: string };
    return data.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Transcription failed: ${message}`);
  }
}
