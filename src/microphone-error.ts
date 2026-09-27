export class MicrophoneUnavailableError extends Error {
  constructor(name: string) {
    super(`Selected microphone is unavailable: ${name}. Open /voice-settings and choose another microphone.`);
    this.name = "MicrophoneUnavailableError";
  }
}
