export class RealtimeClient {
  constructor({ onEvent, onStatus, onTranscript }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onTranscript = onTranscript;
    this.pc = null;
    this.dc = null;
    this.stream = null;
    this.audio = null;
  }

  async connect() {
    this.onStatus("requesting-token");
    const tokenResponse = await fetch("/api/realtime/token");
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json().catch(() => ({}));
      throw new Error(error.error || "Could not create Realtime token.");
    }

    const tokenData = await tokenResponse.json();
    const ephemeralKey = tokenData.value || tokenData.client_secret?.value;
    if (!ephemeralKey) {
      throw new Error("Realtime token response did not include a client secret value.");
    }

    this.onStatus("requesting-microphone");
    this.pc = new RTCPeerConnection();
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.pc.ontrack = (event) => {
      this.audio.srcObject = event.streams[0];
    };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.pc.addTrack(this.stream.getAudioTracks()[0], this.stream);

    this.dc = this.pc.createDataChannel("oai-events");
    this.dc.addEventListener("open", () => {
      this.onStatus("connected");
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "AURA cockpit connected. Cumprimente brevemente o usuario." }]
        }
      });
      this.send({ type: "response.create" });
    });
    this.dc.addEventListener("message", (event) => this.handleEvent(event));
    this.dc.addEventListener("close", () => this.onStatus("closed"));

    this.onStatus("negotiating");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      }
    });

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await this.pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });
  }

  disconnect() {
    this.dc?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.pc = null;
    this.dc = null;
    this.stream = null;
    this.onStatus("idle");
  }

  send(event) {
    if (!this.dc || this.dc.readyState !== "open") {
      return false;
    }

    this.dc.send(JSON.stringify(event));
    return true;
  }

  sendText(text) {
    const ok = this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    });
    if (ok) {
      this.send({ type: "response.create" });
    }
    return ok;
  }

  handleEvent(event) {
    const data = JSON.parse(event.data);
    this.onEvent(data);

    if (data.type === "response.audio_transcript.delta" || data.type === "response.output_text.delta") {
      this.onTranscript(data.delta || "");
    }
  }
}
